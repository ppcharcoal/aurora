<script lang="ts">
  import { prettyPath } from "../native";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { fade, fly } from "svelte/transition";
  import { bytes } from "../format";
  import { lastfm } from "../lastfm.svelte";
  import { profiles } from "../profiles.svelte";
  import { settings, type Settings } from "../settings.svelte";
  import { library } from "../sources/local.svelte";
  import { theme } from "../theme.svelte";
  import { ui } from "../ui.svelte";
  import DataLimit from "../components/DataLimit.svelte";
  import Icon from "../components/Icon.svelte";
  import Vinyl from "../components/Vinyl.svelte";
  import { isAndroid } from "../platform";

  // First-time setup: every step can be skipped, and so can the whole thing.
  const steps = ["welcome", "look", "lastfm", "storage", "done"] as const;
  let step = $state(0);
  let dir = $state(1);
  const m = $derived(settings.value.reduceMotion ? 0 : 1);

  let name = $state(profiles.active?.name === "Me" ? "" : (profiles.active?.name ?? ""));
  // Connecting Last.fm renames the profile; show that.
  $effect(() => {
    if (lastfm.connected && profiles.active?.name) name = profiles.active.name;
  });

  function go(to: number) {
    if (step === 0 && name.trim() && name.trim() !== profiles.active?.name) profiles.rename(profiles.activeId, name).catch(ui.error);
    dir = to > step ? 1 : -1;
    step = Math.max(0, Math.min(steps.length - 1, to));
  }

  function finish() {
    if (name.trim() && name.trim() !== profiles.active?.name) profiles.rename(profiles.activeId, name).catch(ui.error);
    settings.set("setupDone", true);
    ui.go({ name: "home" });
  }

  // Last.fm without a built-in key: paste your own (same as Profile → Connections).
  let key = $state(lastfm.apiKey);
  let secret = $state(lastfm.secret);
  async function saveKeys() {
    await lastfm.saveKeys(key, secret);
    ui.toast("Last.fm key saved", "success", 2000);
  }

  async function chooseFolder() {
    const d = await openDialog({ directory: true, multiple: false, title: "Save downloads to…" });
    if (typeof d !== "string") return;
    settings.set("downloadFolder", d);
    if (!library.covers(d)) library.addFolder(d).catch(ui.error);
  }

  const modes: { v: Settings["theme"]; label: string }[] = [
    { v: "dark", label: "Dark" },
    { v: "light", label: "Light" },
    { v: "system", label: isAndroid ? "Match phone" : "Match Windows" },
  ];
  const backgrounds: { v: Settings["background"]; label: string; note: string }[] = [
    { v: "cover", label: "Cover art", note: "Blurred art of what's playing" },
    { v: "image", label: "Your image", note: "Colours taken from a picture" },
    { v: "plain", label: "Plain", note: "Calm, no pictures" },
  ];
  function pickBackground(v: Settings["background"]) {
    if (v === "image" && !settings.value.wallpaper) theme.chooseWallpaper();
    else settings.set("background", v);
  }

  const lastfmPerks = [
    ["Scrobbling", "Everything you play here counts on your Last.fm profile."],
    ["Loved songs", "♥ a song here or on your phone, it's loved in both places."],
    ["Discover and radio", "Songs by artists similar to what you play."],
    ["Friends", "See what the people you follow are listening to."],
  ];

  const themeLabel = $derived(modes.find((x) => x.v === settings.value.theme)?.label);
  const bgLabel = $derived(backgrounds.find((x) => x.v === theme.background)?.label);
</script>

<div class="setup" transition:fade={{ duration: 200 * m }}>
  <div class="card">
    <header>
      <ol class="dots" aria-label="Setup steps">
        {#each steps as s, i}
          <li class:on={i === step} class:past={i < step}>
            <button onclick={() => go(i)} aria-label={`Step ${i + 1}`} aria-current={i === step ? "step" : undefined}></button>
          </li>
        {/each}
      </ol>
      {#if step < steps.length - 1}
        <button class="skipall" onclick={finish}>Skip setup</button>
      {/if}
    </header>

    <div class="stage">
      {#key step}
        <section class="step" in:fly={{ x: 40 * dir * m, duration: 380 * m, delay: 60 * m }} out:fly={{ x: -30 * dir * m, duration: 160 * m }}>
          {#if steps[step] === "welcome"}
            <div class="hero">
              <div class="disc"><Vinyl spinning size={isAndroid ? "120px" : "170px"} /></div>
              <div>
                <p class="kicker">Welcome to</p>
                <h1>Aurora</h1>
                <p class="lead">Your music, on your {isAndroid ? "phone" : "PC"}. Search any song or album, download it with its cover, and keep it in playlists. A few quick choices and you're in.</p>
                <label class="name">
                  <span>What should we call you?</span>
                  <input class="field" bind:value={name} placeholder="Your name" maxlength="40" onkeydown={(e) => e.key === "Enter" && go(1)} />
                </label>
              </div>
            </div>
          {:else if steps[step] === "look"}
            <h2>Pick a look</h2>
            <p class="lead">Changes show right away. You can change them any time in Settings.</p>
            <div class="modes" role="radiogroup" aria-label="Mode">
              {#each modes as x}
                <button role="radio" aria-checked={settings.value.theme === x.v} class:on={settings.value.theme === x.v} onclick={() => settings.set("theme", x.v)}>
                  <span class="mini {x.v}"><i></i><i></i><i></i></span>
                  <strong>{x.label}</strong>
                </button>
              {/each}
            </div>
            <span class="lbl">Background</span>
            <div class="bgs" role="radiogroup" aria-label="Background">
              {#each backgrounds as b}
                <button role="radio" aria-checked={theme.background === b.v} class:on={theme.background === b.v} onclick={() => pickBackground(b.v)}>
                  <strong>{b.label}</strong><small>{b.note}</small>
                </button>
              {/each}
            </div>
            {#if settings.value.wallpaper}
              <div class="wall">
                <img src={theme.wallpaperSrc} alt="Your theme" />
                <button class="btn" onclick={() => theme.chooseWallpaper()}>Choose another image</button>
              </div>
            {/if}
          {:else if steps[step] === "lastfm"}
            <div class="lfmhead">
              <span class="logo">as</span>
              <div>
                <h2>Connect Last.fm</h2>
                <p class="lead">Optional, and free. It adds:</p>
              </div>
            </div>
            <ul class="perks">
              {#each lastfmPerks as [t, d]}<li><Icon name="check" size={16} stroke={2.4} /><span><b>{t}.</b> {d}</span></li>{/each}
            </ul>
            {#if lastfm.connected}
              <div class="ok">
                <Icon name="check" size={18} stroke={2.6} />
                <span>Connected as <b>{lastfm.cfg.user}</b>. Your profile uses your Last.fm name and picture.</span>
              </div>
            {:else if lastfm.hasKey}
              <button class="btn primary big" onclick={() => lastfm.connect()} disabled={lastfm.busy === "connect"}>
                <Icon name="link" size={16} /> {lastfm.busy === "connect" ? "Waiting for your browser…" : "Sign in with Last.fm"}
              </button>
              <p class="hint">Opens Last.fm in your browser. Approve Aurora there and come back.</p>
            {:else}
              <p class="hint">
                This copy of Aurora has no Last.fm key built in. Create a free one at
                <button class="a" onclick={() => openUrl("https://www.last.fm/api/account/create")}>last.fm/api/account/create</button>
                (callback URL <code>http://127.0.0.1:43822/lastfm</code>) and paste it here:
              </p>
              <div class="keys">
                <input class="field" bind:value={key} placeholder="API key" spellcheck="false" />
                <input class="field" type="password" bind:value={secret} placeholder="Shared secret" spellcheck="false" />
                <button class="btn" onclick={saveKeys} disabled={key.trim().length < 20 || secret.trim().length < 20}>Save</button>
              </div>
            {/if}
          {:else if steps[step] === "storage"}
            <h2>How much space for music?</h2>
            <p class="lead">Set a limit and Aurora won't download past it. Leave it at <b>No limit</b> to use whatever's free.</p>
            <DataLimit />
            <div class="opts" class:one={isAndroid}>
              {#if !isAndroid}
              <div>
                <span class="lbl">File type</span>
                <div class="pair" role="radiogroup" aria-label="File type">
                  <button role="radio" aria-checked={settings.value.quality === "original"} class:on={settings.value.quality === "original"} onclick={() => settings.set("quality", "original")}>
                    <strong>Space saver</strong><small>Original audio, ≈ half the size</small>
                  </button>
                  <button role="radio" aria-checked={settings.value.quality !== "original"} class:on={settings.value.quality !== "original"} onclick={() => settings.set("quality", "best")}>
                    <strong>MP3</strong><small>Plays on anything</small>
                  </button>
                </div>
              </div>
              {/if}
              <div>
                <span class="lbl">Save songs to</span>
                <button class="folder" onclick={chooseFolder} title="Change" disabled={isAndroid}>
                  <Icon name="folder" size={16} />
                  <span>{settings.value.downloadFolder ? prettyPath(settings.value.downloadFolder) : isAndroid ? "Download/Aurora" : "Music\\Aurora"}</span>
                  {#if !isAndroid}<small>Change</small>{/if}
                </button>
              </div>
            </div>
          {:else}
            <div class="done">
              <div class="burst"><Icon name="check" size={40} stroke={2.6} /></div>
              <h2>You're all set{name.trim() ? `, ${name.trim()}` : ""}</h2>
              <ul class="summary">
                <li><span>Look</span><b>{themeLabel}, {bgLabel?.toLowerCase()}</b></li>
                <li><span>Last.fm</span><b>{lastfm.connected ? `Connected as ${lastfm.cfg.user}` : "Not connected"}</b></li>
                <li><span>Data limit</span><b>{settings.value.dataLimit ? bytes(settings.value.dataLimit) : "No limit"}</b></li>
                <li><span>Downloads</span><b>{isAndroid ? "Original audio" : settings.value.quality === "original" ? "Space saver" : "MP3"}</b></li>
              </ul>
              <p class="lead">Search for a song or album at the top to get started. Everything here is in Settings and your profile later.</p>
            </div>
          {/if}
        </section>
      {/key}
    </div>

    <footer>
      {#if step > 0}<button class="btn ghost" onclick={() => go(step - 1)}><Icon name="back" size={15} /> Back</button>{/if}
      <span class="sp"></span>
      {#if step === steps.length - 1}
        <button class="btn primary big" onclick={finish}>Start listening</button>
      {:else if step === 0}
        <button class="btn primary big" onclick={() => go(1)}>Get started</button>
      {:else}
        {#if steps[step] === "lastfm" && !lastfm.connected}
          <button class="btn ghost" onclick={() => go(step + 1)}>Not now</button>
        {:else}
          <button class="btn primary big" onclick={() => go(step + 1)}>Next</button>
        {/if}
      {/if}
    </footer>
  </div>
</div>

<style>
  .setup {
    grid-row: 2 / 4;
    display: grid;
    place-items: center;
    padding: 12px var(--gutter) var(--gutter);
    min-height: 0;
    overflow: auto;
  }
  .card {
    width: min(760px, 100%);
    min-height: min(600px, 100%);
    display: flex;
    flex-direction: column;
    border-radius: 24px;
    background: var(--panel);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    padding: 18px 24px 0;
  }
  .dots {
    display: flex;
    gap: 8px;
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1;
  }
  .dots button {
    display: block;
    width: 8px;
    height: 8px;
    border-radius: 8px;
    background: rgb(var(--ink-rgb) / 0.18);
    transition:
      width var(--t-med) var(--ease-out),
      background var(--t-fast);
  }
  .dots .past button {
    background: rgb(var(--accent-rgb) / 0.55);
  }
  .dots .on button {
    width: 28px;
    background: var(--accent);
  }
  .skipall {
    font-size: 13px;
    color: var(--ink-3);
    padding: 6px 10px;
    border-radius: var(--r-pill);
  }
  .skipall:hover {
    color: var(--ink);
    background: rgb(var(--ink-rgb) / 0.06);
  }
  .stage {
    flex: 1;
    display: grid;
    padding: 18px 40px 8px;
    overflow: hidden;
  }
  .step {
    grid-area: 1 / 1;
    min-width: 0;
    align-self: center;
  }
  h1 {
    font-size: 64px;
    font-variation-settings: "wdth" 80;
    line-height: 1;
    margin: 0 0 14px;
    background: linear-gradient(100deg, var(--ink) 30%, var(--accent) 70%, var(--violet));
    background-clip: text;
    color: transparent;
  }
  h2 {
    font-size: 30px;
    font-variation-settings: "wdth" 85;
    margin: 0 0 6px;
  }
  .kicker {
    margin: 0;
    font-size: 15px;
    color: var(--ink-3);
  }
  .lead {
    margin: 0 0 20px;
    color: var(--ink-2);
    line-height: 1.55;
    max-width: 60ch;
  }
  .hero {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 36px;
    align-items: center;
  }
  .disc {
    filter: drop-shadow(0 18px 30px rgb(0 0 0 / 0.35));
  }

  /* Phone: one column, everything fits the width. */
  :global(html[data-phone]) .setup {
    padding: 8px 10px 10px;
    place-items: stretch;
  }
  :global(html[data-phone]) .card {
    min-height: 100%;
    border-radius: 20px;
  }
  :global(html[data-phone]) header {
    padding: 14px 16px 0;
  }
  :global(html[data-phone]) .stage {
    padding: 12px 18px 8px;
    overflow-y: auto;
  }
  :global(html[data-phone]) .hero {
    grid-template-columns: minmax(0, 1fr);
    gap: 18px;
    justify-items: start;
  }
  :global(html[data-phone]) .hero .disc {
    justify-self: center;
  }
  :global(html[data-phone]) h1 {
    font-size: 48px;
  }
  :global(html[data-phone]) h2 {
    font-size: 26px;
  }
  :global(html[data-phone]) .name {
    max-width: none;
    width: 100%;
  }
  .name {
    display: grid;
    gap: 8px;
    max-width: 340px;
    font-size: 13px;
    color: var(--ink-2);
  }
  .name .field {
    height: 44px;
    font-size: 16px;
  }
  .lbl {
    display: block;
    font-size: 13px;
    color: var(--ink-2);
    margin: 22px 0 8px;
  }
  .modes {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
  }
  .modes button,
  .bgs button,
  .pair button {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 12px;
    border-radius: 14px;
    text-align: left;
    background: var(--well);
    border: 1px solid var(--line);
    transition:
      border-color var(--t-fast),
      background var(--t-fast),
      transform var(--t-fast) var(--ease-out);
  }
  .modes button:hover,
  .bgs button:hover,
  .pair button:hover {
    transform: translateY(-2px);
  }
  .modes button.on,
  .bgs button.on,
  .pair button.on {
    border-color: var(--accent);
    background: rgb(var(--accent-rgb) / 0.1);
  }
  .bgs,
  .pair {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
  }
  .pair {
    grid-template-columns: 1fr 1fr;
  }
  small {
    font-size: 12px;
    color: var(--ink-3);
  }
  /* A tiny drawing of the app in each mode. */
  .mini {
    position: relative;
    display: block;
    height: 84px;
    border-radius: 9px;
    margin-bottom: 8px;
    overflow: hidden;
    background: #15121c;
    border: 1px solid rgb(128 128 128 / 0.25);
  }
  .mini i {
    position: absolute;
    border-radius: 4px;
    background: #2a2436;
  }
  .mini i:nth-child(1) {
    left: 6px;
    top: 6px;
    bottom: 6px;
    width: 26%;
  }
  .mini i:nth-child(2) {
    left: calc(26% + 12px);
    right: 6px;
    top: 6px;
    bottom: 26px;
  }
  .mini i:nth-child(3) {
    left: calc(26% + 12px);
    right: 6px;
    bottom: 6px;
    height: 14px;
    background: rgb(var(--accent-rgb));
    opacity: 0.85;
  }
  .mini.light {
    background: #ece8f3;
  }
  .mini.light i:nth-child(-n + 2) {
    background: #ffffff;
  }
  .mini.system {
    background: linear-gradient(135deg, #15121c 50%, #ece8f3 50%);
  }
  .mini.system i:nth-child(-n + 2) {
    background: linear-gradient(135deg, #2a2436 50%, #ffffff 50%);
    background-attachment: fixed;
  }
  .wall {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
  }
  .wall img {
    width: 96px;
    height: 54px;
    object-fit: cover;
    border-radius: 8px;
  }
  .lfmhead {
    display: flex;
    gap: 16px;
    align-items: center;
  }
  .lfmhead .lead {
    margin: 0;
  }
  .logo {
    width: 52px;
    height: 52px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 14px;
    background: #d51007;
    color: #fff;
    font: 800 22px var(--font-display);
    letter-spacing: -1px;
  }
  .perks {
    list-style: none;
    margin: 18px 0 22px;
    padding: 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px 24px;
  }
  .perks li {
    display: flex;
    gap: 10px;
    color: var(--ink-2);
    font-size: 14px;
    line-height: 1.45;
  }
  .perks li :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--accent);
  }
  .perks b {
    color: var(--ink);
  }
  .ok {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 14px 16px;
    border-radius: 14px;
    background: rgb(var(--accent-rgb) / 0.1);
    border: 1px solid rgb(var(--accent-rgb) / 0.4);
  }
  .ok :global(svg) {
    color: var(--accent);
  }
  .hint {
    font-size: 13px;
    color: var(--ink-3);
    margin: 10px 0;
  }
  .a {
    color: var(--ink);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .keys {
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    gap: 8px;
  }
  .opts {
    display: grid;
    grid-template-columns: 1.2fr 1fr;
    gap: 18px;
    margin-top: 4px;
  }
  .opts.one {
    grid-template-columns: 1fr;
  }
  .folder {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 58px;
    padding: 0 14px;
    border-radius: 14px;
    background: var(--well);
    border: 1px solid var(--line);
    text-align: left;
  }
  .folder span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
  }
  .folder:hover {
    border-color: rgb(var(--accent-rgb) / 0.5);
  }
  .done {
    text-align: center;
    display: grid;
    justify-items: center;
  }
  .burst {
    width: 84px;
    height: 84px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    margin-bottom: 18px;
    color: var(--on-accent);
    background: var(--accent);
    box-shadow: 0 0 0 10px rgb(var(--accent-rgb) / 0.15), 0 0 0 22px rgb(var(--accent-rgb) / 0.07);
    animation: pop 600ms var(--ease-spring) both;
  }
  @keyframes pop {
    from {
      transform: scale(0.4);
      opacity: 0;
    }
  }
  .summary {
    list-style: none;
    margin: 14px 0 18px;
    padding: 6px 18px;
    width: min(420px, 100%);
    border-radius: 14px;
    background: var(--well);
    border: 1px solid var(--line);
  }
  .summary li {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 9px 0;
    font-size: 14px;
  }
  .summary li + li {
    border-top: 1px solid var(--line);
  }
  .summary span {
    color: var(--ink-3);
  }
  footer {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 24px 22px;
  }
  .sp {
    flex: 1;
  }
  .btn.big {
    height: 42px;
    padding: 0 24px;
    font-size: 15px;
  }
  .btn.ghost {
    background: transparent;
  }
  .btn.ghost:hover {
    background: rgb(var(--ink-rgb) / 0.08);
  }
</style>
