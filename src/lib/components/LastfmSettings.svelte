<script lang="ts">
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { lastfm, type LfmOptions } from "../lastfm.svelte";
  import { ui } from "../ui.svelte";
  import Icon from "./Icon.svelte";

  // Never pre-filled: a saved key stays out of sight.
  let key = $state("");
  let secret = $state("");
  let editing = $state(!lastfm.hasKey);
  $effect(() => {
    if (lastfm.builtin) editing = false;
  });
  let applying = $state(false);
  async function useProfile() {
    applying = true;
    try {
      await lastfm.useLastfmProfile();
      ui.toast("Profile updated from Last.fm", "success", 2200);
    } catch (e) {
      ui.error(e);
    } finally {
      applying = false;
    }
  }

  async function saveKeys() {
    await lastfm.saveKeys(key, secret);
    key = secret = "";
    editing = false;
    ui.toast("Last.fm key saved", "success", 2000);
  }

  const options: { k: keyof LfmOptions; label: string; note: string; needsLogin: boolean }[] = [
    { k: "scrobble", label: "Scrobble what I play", note: "After half the song or 4 minutes, like every Last.fm app. Kept and sent later if you're offline.", needsLogin: true },
    { k: "nowPlaying", label: "Show “now playing” on my profile", note: "", needsLogin: true },
    { k: "syncLoved", label: "Sync loved songs (♥) both ways", note: "Loving a song here loves it on Last.fm, and the other way round.", needsLogin: true },
    { k: "autoDownloadLoved", label: "Download songs I love on other devices", note: "When a new ♥ arrives from Last.fm and the song isn't here, it's downloaded.", needsLogin: true },
    { k: "discover", label: "Discover on Home", note: "Songs by artists similar to what you play.", needsLogin: false },
    { k: "artistInfo", label: "Artist info on album pages", note: "Bio, genre tags and picture.", needsLogin: false },
  ];

  const date = (ms?: number) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "");
</script>

<section class="lfm">
  <header>
    <span class="logo">as</span>
    <h2>Last.fm</h2>
    {#if lastfm.connected}
      <span class="state on">Connected as {lastfm.cfg.user}</span>
    {:else if lastfm.hasKey}
      <span class="state">Not connected</span>
    {:else}
      <span class="state">Needs a key</span>
    {/if}
  </header>

  {#if editing}
    <ol class="steps">
      <li>
        Open <button class="a" onclick={() => openUrl("https://www.last.fm/api/account/create")}>Last.fm → Create API account</button>
        (free; sign in with your Last.fm account).
      </li>
      <li>Application name: <b>Aurora</b>. Callback URL: <code>http://127.0.0.1:43822/lastfm</code>. The other fields can stay empty.</li>
      <li>Copy the <b>API key</b> and <b>Shared secret</b> here.</li>
    </ol>
    <div class="keys">
      <label><span>API key</span><input class="field" type="password" bind:value={key} spellcheck="false" autocomplete="off" placeholder={lastfm.customKey ? "Saved; paste a new one to replace it" : ""} /></label>
      <label><span>Shared secret</span><input class="field" type="password" bind:value={secret} spellcheck="false" autocomplete="off" /></label>
    </div>
    <div class="row">
      <button class="btn primary" onclick={saveKeys} disabled={key.trim().length < 20 || secret.trim().length < 20}>Save key</button>
      {#if lastfm.hasKey}<button class="btn" onclick={() => (editing = false)}>Cancel</button>{/if}
    </div>
  {:else}
    <div class="row">
      {#if lastfm.connected}
        <button class="btn" onclick={() => openUrl(`https://www.last.fm/user/${lastfm.cfg.user}`)}><Icon name="link" size={15} /> Open my Last.fm</button>
        <button class="btn" onclick={useProfile} disabled={applying}><Icon name="edit" size={15} /> Use my Last.fm picture and name</button>
        <button class="btn" onclick={() => lastfm.disconnect()}>Disconnect</button>
      {:else}
        <button class="btn primary" onclick={() => lastfm.connect()} disabled={lastfm.busy === "connect"}>
          <Icon name="link" size={15} /> {lastfm.busy === "connect" ? "Waiting for the browser…" : "Connect Last.fm"}
        </button>
      {/if}
      <!-- Builds with a key built in always use it: nothing to change. -->
      {#if !lastfm.builtin}<button class="btn ghost" onclick={() => (editing = true)}>Change key</button>{/if}
    </div>

    <ul class="opts">
      {#each options as o (o.k)}
        <li class:dim={o.needsLogin && !lastfm.connected}>
          <label class="toggle">
            <input type="checkbox" checked={lastfm.cfg[o.k]} onchange={(e) => lastfm.setOption(o.k, e.currentTarget.checked)} />
            <span class="sw"></span>
            <span class="txt"><span>{o.label}</span>{#if o.note}<small>{o.note}</small>{/if}</span>
          </label>
        </li>
      {/each}
    </ul>

    {#if lastfm.connected}
      <div class="import">
        <div>
          <strong>Your Last.fm history</strong>
          {#if lastfm.history}
            <small>{lastfm.history.playcount.toLocaleString()} scrobbles{lastfm.history.registered ? ` since ${date(lastfm.history.registered)}` : ""}; imported {date(lastfm.history.importedAt)}.</small>
          {:else}
            <small>Bring in your all-time play counts: top songs and artists show on this page, and matching songs here get their play counts.</small>
          {/if}
        </div>
        <button class="btn" onclick={() => lastfm.importHistory()} disabled={lastfm.busy === "import"}>
          <Icon name="download" size={15} /> {lastfm.busy === "import" ? "Importing…" : lastfm.history ? "Import again" : "Import history"}
        </button>
      </div>
      {#if lastfm.queueSize}
        <p class="note">{lastfm.queueSize} scrobbles waiting to be sent. <button class="a" onclick={() => lastfm.flush()}>Send now</button></p>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .lfm {
    padding: 22px 24px;
    border-radius: var(--r-panel);
    background: rgb(var(--ink-rgb) / 0.04);
    border: 1px solid var(--line);
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 14px;
  }
  .logo {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 7px;
    font: 700 13px var(--font-display);
    color: #fff;
    background: #d51007;
  }
  h2 {
    font-size: 20px;
  }
  .state {
    margin-left: auto;
    font-size: 12px;
    padding: 3px 10px;
    border-radius: var(--r-pill);
    color: var(--ink-3);
    border: 1px solid var(--line);
  }
  .state.on {
    color: var(--accent);
    border-color: rgb(var(--accent-rgb) / 0.4);
  }
  .steps {
    margin: 0 0 14px;
    padding-left: 20px;
    color: var(--ink-2);
    line-height: 1.8;
  }
  .a {
    color: var(--ink);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  code {
    padding: 2px 8px;
    border-radius: 6px;
    background: var(--well);
    font-size: 13px;
    user-select: all;
  }
  .keys {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 12px;
  }
  .keys span {
    display: block;
    font-size: 13px;
    color: var(--ink-2);
    margin-bottom: 6px;
  }
  .row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .btn.ghost {
    background: none;
    color: var(--ink-2);
  }
  .opts {
    list-style: none;
    margin: 18px 0 0;
    padding: 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px 24px;
  }
  .opts li.dim {
    opacity: 0.5;
  }
  .toggle {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    cursor: pointer;
  }
  .toggle input {
    position: absolute;
    opacity: 0;
  }
  .sw {
    position: relative;
    width: 40px;
    height: 22px;
    margin-top: 1px;
    border-radius: 22px;
    background: rgb(var(--ink-rgb) / 0.16);
    transition: background var(--t-fast);
    flex: none;
  }
  .sw::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.3);
    transition: transform var(--t-med) var(--ease-spring);
  }
  .toggle input:checked + .sw {
    background: var(--accent);
  }
  .toggle input:checked + .sw::after {
    transform: translateX(18px);
  }
  .toggle input:focus-visible + .sw {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .txt {
    display: flex;
    flex-direction: column;
  }
  .txt small,
  .import small {
    color: var(--ink-3);
    font-size: 12px;
  }
  .import {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid var(--line);
  }
  .import div {
    display: flex;
    flex-direction: column;
    max-width: 60ch;
  }
  .note {
    font-size: 13px;
    color: var(--ink-3);
    margin: 12px 0 0;
  }

  /* Phone: one option per row, the "connected" badge on its own line if needed. */
  :global(html[data-phone]) .lfm {
    padding: 16px;
  }
  :global(html[data-phone]) header {
    flex-wrap: wrap;
  }
  :global(html[data-phone]) .state {
    margin-left: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  :global(html[data-phone]) .opts,
  :global(html[data-phone]) .keys {
    grid-template-columns: minmax(0, 1fr);
  }
  :global(html[data-phone]) .row :global(.btn) {
    flex: 1 1 auto;
  }
</style>
