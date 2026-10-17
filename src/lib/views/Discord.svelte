<script lang="ts">
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { discord, PORTAL_URL } from "../discord.svelte";
  import { player } from "../player.svelte";
  import { ui } from "../ui.svelte";
  import Icon from "../components/Icon.svelte";

  let token = $state("");
  let busy = $state(false);
  let changing = $state(false);
  let guildId = $state<string | null>(null);

  // Show the server the bot is in (or was last in) first.
  const guild = $derived(
    discord.guilds.find((g) => g.id === guildId) ??
      discord.guilds.find((g) => g.id === discord.voice.guildId) ??
      discord.guilds.find((g) => g.id === discord.cfg.last?.guildId) ??
      discord.guilds[0] ??
      null,
  );
  const inChannel = (id: string) => discord.voice.voice !== "off" && discord.voice.channelId === id;
  const channelName = $derived(
    discord.guilds.flatMap((g) => g.channels.map((c) => ({ ...c, g: g.name }))).find((c) => c.id === discord.voice.channelId) ?? null,
  );

  async function connect() {
    if (!token.trim()) return;
    busy = true;
    try {
      await discord.connect(token);
      token = "";
      changing = false;
    } catch (e) {
      discord.error = String(e);
    } finally {
      busy = false;
    }
  }

</script>

<div class="page narrow">
  <h1 class="page-title">Discord</h1>
  <p class="lead">
    Play your music in a Discord voice channel through your own bot, controlled from here. The bot runs inside Aurora on this
    computer: it's online while Aurora is open, and plays songs straight from your files, so friends hear them clean.
  </p>

  {#if discord.error}
    <div class="alert" role="alert">
      <Icon name="x" size={16} />
      <p>{discord.error}</p>
      <button class="icon" onclick={() => (discord.error = "")} aria-label="Dismiss"><Icon name="x" size={14} /></button>
    </div>
  {/if}

  {#if !discord.token.saved || changing}
    <!-- ------------------------------------------------------------ setup -->
    <section class="card">
      <header><Icon name="bot" size={20} /><h2>{changing ? "Use a different bot" : "Set up your bot"}</h2><span class="state">once, about 3 minutes</span></header>
      <p class="note first">
        Every Aurora uses its own bot, made with your Discord account. Discord gives the bot a <b>token</b>, a long secret code that lets Aurora sign in as the
        bot. Here's how to get it:
      </p>
      <ol class="steps">
        <li>
          <b>Open the Discord Developer Portal</b> and sign in with your normal Discord account.
          <button class="btn sm" onclick={() => openUrl(PORTAL_URL)}><Icon name="link" size={14} /> Open the Developer Portal</button>
        </li>
        <li>
          Click <b>New Application</b> (top right). Give it a name, for example <i>Aurora</i>: this is the bot's name everyone sees. Tick the box to accept the
          terms and click <b>Create</b>.
        </li>
        <li>
          In the menu on the left, click <b>Bot</b>. Under <i>Token</i>, click <b>Reset Token</b>, confirm with <b>Yes, do it!</b> (Discord may ask for your
          password or two-factor code), then click <b>Copy</b>.
          <small>You can leave the three “Privileged Gateway Intents” switches off: Aurora doesn't need them. Optional: turn off <i>Public Bot</i> so only you can add it to servers.</small>
        </li>
        <li>
          <b>Paste the token here</b> and connect:
          <form class="tokenrow" onsubmit={(e) => (e.preventDefault(), connect())}>
            <input class="field" type="password" bind:value={token} placeholder="Paste the bot token" spellcheck="false" autocomplete="off" aria-label="Bot token" />
            <button class="btn primary" type="submit" disabled={busy || !token.trim()}>{busy ? "Connecting…" : "Connect bot"}</button>
            {#if changing}<button class="btn" type="button" onclick={() => (changing = false)}>Cancel</button>{/if}
          </form>
        </li>
        <li>
          <b>Add the bot to your server</b>: after connecting, click <i>Add to a server</i>, pick the server and click <b>Authorize</b>. You need the
          <i>Manage Server</i> permission there (on your own server you have it). Then pick a voice channel below and press <b>Join</b>, and play something in Aurora.
        </li>
      </ol>
      <div class="warn">
        <Icon name="settings" size={16} />
        <p>
          <b>Keep the token secret</b>: it works like a password for your bot. Aurora keeps it only on this computer (not in backups) and sends it only to Discord.
          If you ever shared it by mistake, click <i>Reset Token</i> in the portal again and paste the new one here.
        </p>
      </div>
    </section>
  {:else}
    <!-- -------------------------------------------------------------- bot -->
    <section class="card">
      <header>
        <Icon name="bot" size={20} /><h2>Your bot</h2>
        <span class="state" class:on={discord.status === "online"}>
          {discord.status === "online" ? "Online" : discord.status === "starting" ? "Connecting…" : discord.status === "offline" ? "Reconnecting…" : "Not connected"}
        </span>
      </header>
      <div class="botrow">
        {#if discord.bot}
          {#if discord.bot.avatar}<img class="avatar" src={discord.bot.avatar} alt="" />{:else}<div class="avatar ph"><Icon name="bot" size={22} /></div>{/if}
          <div class="who"><b>{discord.bot.name}</b><small>Token {discord.token.hint}</small></div>
        {:else}
          <div class="avatar ph"><Icon name="bot" size={22} /></div>
          <div class="who"><b>Saved bot</b><small>Token {discord.token.hint}</small></div>
        {/if}
        <div class="actions">
          {#if discord.status === "off"}
            <button class="btn primary" onclick={() => discord.start().catch(() => {})}>Connect</button>
          {:else}
            <button class="btn" onclick={() => discord.invite && openUrl(discord.invite)} disabled={!discord.invite}><Icon name="plus" size={15} /> Add to a server</button>
            <button class="btn" onclick={() => discord.stop()}>Disconnect</button>
          {/if}
        </div>
      </div>
      <p class="links">
        <button class="a" onclick={() => (changing = true)}>Use a different token</button> ·
        <button class="a" onclick={() => discord.forget().catch(ui.error)}>Remove the bot from Aurora</button>
      </p>
    </section>

    {#if discord.status === "online"}
      <!-- ------------------------------------------------------- channel -->
      <section class="card">
        <header>
          <Icon name="output" size={20} /><h2>Voice channel</h2>
          {#if discord.voice.voice !== "off"}
            <span class="state on">{discord.voice.voice === "connected" ? "Live" : "Joining…"}</span>
          {/if}
        </header>
        {#if !discord.guilds.length}
          <p class="note first">The bot isn't in any server yet. Click <b>Add to a server</b> above, choose a server you manage and authorize it; it shows up here right away.</p>
          <button class="btn primary" onclick={() => openUrl(discord.invite)}><Icon name="plus" size={15} /> Add to a server</button>
        {:else}
          {#if discord.guilds.length > 1}
            <div class="guilds" role="tablist" aria-label="Servers">
              {#each discord.guilds as g (g.id)}
                <button role="tab" aria-selected={guild?.id === g.id} class:on={guild?.id === g.id} onclick={() => (guildId = g.id)}>
                  {#if g.icon}<img src={g.icon} alt="" />{:else}<span class="gi">{g.name.slice(0, 1)}</span>{/if}
                  {g.name}
                </button>
              {/each}
            </div>
          {/if}
          {#if guild}
            {#if !guild.channels.length}
              <p class="note first">The bot can't see any voice channels in {guild.name}. Give its role <i>View Channel</i> and <i>Connect</i> on the channel you want.</p>
            {/if}
            <ul class="channels">
              {#each guild.channels as c (c.id)}
                <li class:here={inChannel(c.id)}>
                  <Icon name="volume" size={17} />
                  <span class="cname">{c.name}</span>
                  {#if c.listeners}<small>{c.listeners} listening</small>{/if}
                  {#if inChannel(c.id)}
                    <button class="btn sm" onclick={() => discord.leave()}>Leave</button>
                  {:else}
                    <button class="btn sm primary" onclick={() => discord.join(guild.id, c.id)}>Join</button>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
          {#if discord.live}
            <p class="nowline">
              <Icon name="check" size={15} />
              <span>
              {#if player.current}
                {player.playing ? "Playing" : "Paused:"} <b>{player.current.title}</b> in <b>{channelName?.name}</b>. Aurora's player controls it; this computer stays quiet.
              {:else}
                In <b>{channelName?.name}</b>. Press play in Aurora and the music plays there.
              {/if}
              </span>
            </p>
          {/if}
        {/if}
      </section>
    {/if}

    <!-- -------------------------------------------------------- options -->
    <section class="card">
      <header><Icon name="settings" size={20} /><h2>Playing in Discord</h2></header>
      <p class="note first">
        While the bot is in a voice channel it is Aurora's speaker: this computer stays quiet, and Aurora's play, pause, skip and volume control
        the music in the call. Join the call to listen along. When the bot leaves, the music comes out of this computer again.
      </p>
      <label class="toggle">
        <input type="checkbox" checked={discord.cfg.nowPlaying} onchange={(e) => discord.set("nowPlaying", e.currentTarget.checked)} />
        <span class="sw"></span>
        <span>Post a “now playing” card in the voice channel's chat when a song starts</span>
      </label>
      <label class="toggle">
        <input type="checkbox" checked={discord.cfg.autoStart} onchange={(e) => discord.set("autoStart", e.currentTarget.checked)} />
        <span class="sw"></span>
        <span>Connect the bot when Aurora starts</span>
      </label>
    </section>

  {/if}

  <p class="foot">
    Want “Listening to …” on your Discord profile too? <button class="a" onclick={() => ui.go({ name: "settings" })}>Settings → Discord status</button>
  </p>
</div>

<style>
  .narrow {
    max-width: 780px;
  }
  .lead {
    margin: -8px 0 22px;
    color: var(--ink-2);
    max-width: 66ch;
  }
  .card {
    padding: 22px 24px;
    margin-bottom: 18px;
    border-radius: var(--r-panel);
    background: rgb(var(--ink-rgb) / 0.04);
    border: 1px solid var(--line);
  }
  .card header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
    color: var(--accent);
  }
  .card h2 {
    font-size: 20px;
    color: var(--ink);
  }
  .state {
    margin-left: auto;
    font-size: 12px;
    padding: 3px 10px;
    border-radius: var(--r-pill);
    color: var(--ink-3);
    border: 1px solid var(--line);
    white-space: nowrap;
  }
  .state.on {
    color: var(--accent);
    border-color: rgb(var(--accent-rgb) / 0.4);
  }
  .note {
    font-size: 13px;
    color: var(--ink-3);
    margin: 14px 0 0;
    max-width: 66ch;
  }
  .note.first {
    margin: 0 0 14px;
  }
  .steps {
    margin: 0;
    padding-left: 22px;
    display: grid;
    gap: 14px;
  }
  .steps li {
    line-height: 1.5;
    padding-left: 4px;
  }
  .steps li::marker {
    color: var(--accent);
    font-weight: 700;
  }
  .steps small {
    display: block;
    color: var(--ink-3);
    margin-top: 4px;
  }
  .steps .btn {
    margin-top: 8px;
    display: flex;
    width: fit-content;
  }
  .btn.sm {
    height: 30px;
    padding: 0 12px;
    font-size: 13px;
  }
  .tokenrow {
    display: flex;
    gap: 10px;
    margin-top: 8px;
  }
  .tokenrow .field {
    flex: 1;
    min-width: 0;
  }
  .warn,
  .alert {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    margin-top: 18px;
    padding: 12px 14px;
    border-radius: 12px;
    background: rgb(var(--accent-rgb) / 0.08);
    border: 1px solid rgb(var(--accent-rgb) / 0.25);
    color: var(--accent);
  }
  .warn p,
  .alert p {
    margin: 0;
    color: var(--ink-2);
    font-size: 13px;
    flex: 1;
  }
  .alert {
    margin: 0 0 18px;
    background: rgb(220 70 70 / 0.1);
    border-color: rgb(220 70 70 / 0.35);
    color: rgb(240 110 110);
  }
  .alert p {
    color: var(--ink);
    white-space: pre-line;
  }
  .alert .icon {
    color: var(--ink-3);
  }
  .botrow {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
  }
  .avatar {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    flex: none;
  }
  .avatar.ph {
    display: grid;
    place-items: center;
    background: var(--well);
    color: var(--ink-3);
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .who b {
    font-size: 17px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .who small {
    color: var(--ink-3);
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .links {
    margin: 14px 0 0;
    font-size: 13px;
    color: var(--ink-3);
  }
  .a {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
    font-size: inherit;
  }
  .guilds {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }
  .guilds button {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px 6px 6px;
    border-radius: var(--r-pill);
    background: var(--well);
    border: 1px solid var(--line);
    max-width: 240px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .guilds button.on {
    border-color: var(--accent);
    background: rgb(var(--accent-rgb) / 0.1);
  }
  .guilds img,
  .gi {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    flex: none;
  }
  .gi {
    display: grid;
    place-items: center;
    background: rgb(var(--accent-rgb) / 0.25);
    font-size: 12px;
    font-weight: 700;
  }
  .channels {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .channels li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 8px 8px 12px;
    border-radius: 12px;
    background: var(--well);
    border: 1px solid var(--line);
    color: var(--ink-2);
  }
  .channels li.here {
    border-color: var(--accent);
    background: rgb(var(--accent-rgb) / 0.1);
    color: var(--accent);
  }
  .cname {
    flex: 1;
    min-width: 0;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .channels small {
    color: var(--ink-3);
    white-space: nowrap;
  }
  .nowline {
    display: flex;
    gap: 8px;
    align-items: baseline;
    margin: 14px 0 0;
    font-size: 13px;
    color: var(--ink-2);
  }
  .nowline :global(svg) {
    color: var(--accent);
    flex: none;
    align-self: center;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 12px;
    cursor: pointer;
    margin-bottom: 12px;
  }
  .toggle input {
    position: absolute;
    opacity: 0;
  }
  .sw {
    position: relative;
    width: 40px;
    height: 22px;
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
  .foot {
    font-size: 13px;
    color: var(--ink-3);
  }
  :global(html[data-phone]) .card {
    padding: 18px 16px;
  }
  @media (max-width: 720px) {
    .tokenrow {
      flex-wrap: wrap;
    }
  }
</style>
