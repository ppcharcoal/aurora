<script lang="ts">
  import { discord } from "../discord.svelte";
  import { downloads } from "../downloads.svelte";
  import { lastfm } from "../lastfm.svelte";
  import { playlists } from "../playlists.svelte";
  import { profiles } from "../profiles.svelte";
  import { stats } from "../stats.svelte";
  import { library } from "../sources/local.svelte";
  import type { Route } from "../types";
  import { ui } from "../ui.svelte";
  import Icon, { type IconName } from "./Icon.svelte";
  import Mosaic from "./Mosaic.svelte";
  import StorageMeter from "./StorageMeter.svelte";

  type Nav = "home" | "search" | "library" | "loved" | "friends" | "downloads" | "discord";
  const nav: { route: Nav; label: string; icon: IconName }[] = [
    { route: "home", label: "Home", icon: "home" },
    { route: "search", label: "Search", icon: "search" },
    { route: "library", label: "Library", icon: "disc" },
    { route: "loved", label: "Loved", icon: "heart" },
    { route: "friends", label: "Friends", icon: "users" },
    { route: "downloads", label: "Downloads", icon: "download" },
    // The Discord bot (Windows and Linux only).
    ...(discord.supported ? [{ route: "discord" as Nav, label: "Discord", icon: "bot" as IconName }] : []),
  ];

  const listened = $derived.by(() => {
    const min = Math.floor(stats.value.totalMs / 60000);
    return min < 60 ? `${min} min listened` : `${Math.floor(min / 60)} h ${min % 60} min listened`;
  });

  const isActive = (r: Nav) => ui.route.name === r || (r === "library" && ui.route.name === "album");
  const playlistActive = (id: string) => ui.route.name === "playlist" && ui.route.id === id;
</script>

<nav class="side">
  {#each nav as it}
    <button class="item" class:active={isActive(it.route)} onclick={() => ui.go({ name: it.route } as Route)}>
      <Icon name={it.icon} size={19} />
      <span class="lbl">{it.label}</span>
      {#if it.route === "downloads" && downloads.active}
        <span class="badge">{downloads.active}</span>
      {:else if it.route === "discord" && discord.live}
        <span class="live">Live</span>
      {:else if it.route === "library" && library.tracks.length}
        <small>{library.tracks.length}</small>
      {:else if it.route === "loved" && lastfm.lovedLocal.length}
        <small>{lastfm.lovedLocal.length}</small>
      {/if}
    </button>
  {/each}

  {#if library.scanning}
    <div class="scan">
      <small>Scanning {library.progress.done} / {library.progress.total || "…"}</small>
      <div class="rail">
        <div class="fill" style:transform={`scaleX(${library.progress.total ? library.progress.done / library.progress.total : 0.05})`}></div>
      </div>
    </div>
  {/if}

  <div class="group">
    <h2>Playlists</h2>
    <button class="new" onclick={() => playlists.createInteractive().then((id) => id && ui.go({ name: "playlist", id }))} aria-label="New playlist" title="New playlist">
      <Icon name="plus" size={16} />
    </button>
  </div>

  <div class="lists">
    {#each playlists.list as p (p.id)}
      <button
        class="pl"
        class:active={playlistActive(p.id)}
        onclick={() => ui.go({ name: "playlist", id: p.id })}
        oncontextmenu={(e) =>
          ui.openMenu(e, [
            { label: "Choose cover image…", icon: "reveal", action: () => playlists.chooseCover(p.id) },
            ...(p.cover ? [{ label: "Remove cover image", icon: "x" as const, action: () => playlists.removeCover(p.id) }] : []),
          ])}
      >
        <Mosaic covers={playlists.covers(p)} size={34} radius="7px" />
        <span class="txt">
          <span class="name">{p.name}</span>
          <small>{p.trackIds.length} {p.trackIds.length === 1 ? "song" : "songs"}</small>
        </span>
      </button>
    {:else}
      <p class="hint">Make a playlist to keep songs together. Downloads can go straight into one.</p>
    {/each}
  </div>

  <StorageMeter />
  <div class="foot">
    <button class="me" class:active={ui.route.name === "profile"} onclick={() => ui.go({ name: "profile" })} title="Your profile">
      <span class="av">
        {#if profiles.active?.avatar}<img src={profiles.avatarSrc(profiles.active)} alt="" />{:else}{(profiles.active?.name ?? "?").charAt(0).toUpperCase()}{/if}
      </span>
      <span class="txt">
        <span class="name">{profiles.active?.name}</span>
        <small>{listened}</small>
      </span>
    </button>
    <button class="gear" class:active={ui.route.name === "settings"} onclick={() => ui.go({ name: "settings" })} aria-label="Settings" title="Settings">
      <Icon name="settings" size={19} />
    </button>
  </div>
</nav>

<style>
  .live {
    margin-left: auto;
    font-size: 11px;
    font-weight: 700;
    padding: 1px 8px;
    border-radius: var(--r-pill);
    color: var(--night);
    background: var(--accent);
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px 12px 12px;
    min-height: 0;
    border-radius: var(--r-panel);
    background: var(--panel);
    border: 1px solid var(--line);
  }
  .item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 14px;
    height: 42px;
    padding: 0 12px;
    border-radius: 12px;
    color: var(--ink-2);
    font-weight: 600;
    text-align: left;
    transition:
      background var(--t-fast),
      color var(--t-fast);
  }
  .item:hover,
  .pl:hover {
    color: var(--ink);
    background: rgb(var(--ink-rgb) / 0.05);
  }
  .item.active,
  .pl.active {
    color: var(--ink);
    background: rgb(var(--ink-rgb) / 0.09);
  }
  /* Active indicator slides in from the left edge. */
  .item::before,
  .pl::before {
    content: "";
    position: absolute;
    left: -12px;
    top: 50%;
    width: 4px;
    height: 20px;
    border-radius: 0 4px 4px 0;
    background: var(--accent);
    transform: translate(-4px, -50%) scaleY(0.4);
    opacity: 0;
    transition:
      transform var(--t-med) var(--ease-spring),
      opacity var(--t-fast);
  }
  .item.active::before,
  .pl.active::before {
    transform: translate(0, -50%) scaleY(1);
    opacity: 1;
  }
  .lbl {
    flex: 1;
  }
  small {
    font-weight: 400;
    font-size: 12px;
    color: var(--ink-3);
  }
  .badge {
    min-width: 22px;
    height: 22px;
    padding: 0 7px;
    border-radius: 11px;
    display: grid;
    place-items: center;
    font-size: 12px;
    font-weight: 700;
    background: var(--accent);
    color: var(--on-accent);
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      box-shadow: 0 0 0 5px rgb(var(--accent-rgb) / 0.18);
    }
  }
  .group {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 22px 4px 6px 12px;
  }
  .group h2 {
    font: 600 12px var(--font-ui);
    letter-spacing: 0.02em;
    color: var(--ink-3);
  }
  .new {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    color: var(--ink-2);
  }
  .new:hover {
    background: rgb(var(--ink-rgb) / 0.08);
    color: var(--ink);
  }
  .lists {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    margin: 0 -6px;
    padding: 0 6px;
  }
  .pl {
    position: relative;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 8px;
    border-radius: 10px;
    text-align: left;
    color: var(--ink-2);
    transition: background var(--t-fast);
  }
  .pl::before {
    left: -6px;
  }
  .txt {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.25;
  }
  .name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hint {
    font-size: 13px;
    color: var(--ink-3);
    padding: 0 12px;
    margin: 4px 0;
  }
  .foot {
    display: flex;
    gap: 6px;
    align-items: center;
    padding-top: 8px;
    border-top: 1px solid var(--line);
  }
  .me {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: 12px;
    text-align: left;
    transition: background var(--t-fast);
  }
  .me:hover,
  .me.active {
    background: rgb(var(--ink-rgb) / 0.07);
  }
  .av {
    width: 36px;
    height: 36px;
    flex: none;
    border-radius: 50%;
    overflow: hidden;
    display: grid;
    place-items: center;
    font-weight: 700;
    color: var(--night);
    background: linear-gradient(140deg, var(--violet), rgb(var(--accent-rgb)));
  }
  .av img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .gear {
    width: 40px;
    height: 40px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 12px;
    color: var(--ink-2);
  }
  .gear:hover,
  .gear.active {
    color: var(--ink);
    background: rgb(var(--ink-rgb) / 0.07);
  }
  .scan {
    padding: 10px 12px 0;
  }
  .rail {
    margin-top: 6px;
    height: 3px;
    border-radius: 3px;
    background: rgb(var(--ink-rgb) / 0.1);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transform-origin: left;
    transition: transform var(--t-med) var(--ease-out);
  }
</style>
