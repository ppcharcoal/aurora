<script lang="ts">
  import { fly } from "svelte/transition";
  import { downloads } from "../downloads.svelte";
  import { player } from "../player.svelte";
  import { profiles } from "../profiles.svelte";
  import { settings } from "../settings.svelte";
  import type { Route } from "../types";
  import { ui } from "../ui.svelte";
  import Artwork from "./Artwork.svelte";
  import Icon, { type IconName } from "./Icon.svelte";

  // Phone layout: a mini player above the tab bar. Tap it for the full player.
  type Tab = "home" | "search" | "library" | "downloads" | "profile";
  const tabs: { route: Tab; label: string; icon: IconName }[] = [
    { route: "home", label: "Home", icon: "home" },
    { route: "search", label: "Search", icon: "search" },
    { route: "library", label: "Library", icon: "disc" },
    { route: "downloads", label: "Downloads", icon: "download" },
    { route: "profile", label: "You", icon: "users" },
  ];
  const active = (r: Tab) =>
    ui.route.name === r ||
    (r === "library" && (ui.route.name === "album" || ui.route.name === "playlist")) ||
    (r === "profile" && (ui.route.name === "settings" || ui.route.name === "loved" || ui.route.name === "friends"));

  const t = $derived(player.current);
  const pct = $derived(player.duration ? Math.min(1, player.position / player.duration) : 0);
  const m = $derived(settings.value.reduceMotion ? 0 : 1);
  const avatar = $derived(profiles.avatarSrc(profiles.active));
</script>

<div class="dock">
  {#if t}
    <div class="mini" transition:fly={{ y: 20 * m, duration: 260 * m }}>
      <button class="open" onclick={() => (ui.sheetOpen = true)} aria-label="Open the player">
        <Artwork src={t.art} size={42} radius="8px" />
        <span class="text">
          <span class="title">{t.title}</span>
          <span class="artist">{t.artist}</span>
        </span>
      </button>
      <button class="ctl" onclick={() => player.toggle()} aria-label={player.playing ? "Pause" : "Play"}>
        <Icon name={player.playing ? "pause" : "play"} size={22} />
      </button>
      <button class="ctl" onclick={() => player.next()} aria-label="Next"><Icon name="next" size={20} /></button>
      <div class="bar"><div style:transform={`scaleX(${pct})`}></div></div>
    </div>
  {/if}

  <nav class="tabs">
    {#each tabs as it (it.route)}
      <button class:on={active(it.route)} onclick={() => ui.go({ name: it.route } as Route)} aria-label={it.label}>
        <span class="ico">
          {#if it.route === "profile" && avatar}
            <img src={avatar} alt="" />
          {:else}
            <Icon name={it.icon} size={21} />
          {/if}
          {#if it.route === "downloads" && downloads.active}<span class="badge">{downloads.active}</span>{/if}
        </span>
        <span class="lbl">{it.label}</span>
      </button>
    {/each}
  </nav>
</div>

<style>
  .dock {
    position: relative;
    z-index: 4;
    padding: 6px var(--gutter) calc(var(--safe-bottom) + 4px);
  }
  .mini {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 6px;
    padding: 6px 6px 6px 6px;
    border-radius: 16px;
    background: var(--glass-strong);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    text-align: left;
  }
  .text {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .title,
  .artist {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .title {
    font-weight: 650;
    font-size: 14px;
  }
  .artist {
    font-size: 12px;
    color: var(--ink-3);
  }
  .ctl {
    width: 44px;
    height: 44px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 50%;
  }
  .ctl:active {
    background: rgb(var(--ink-rgb) / 0.1);
  }
  .bar {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 0;
    height: 2px;
    border-radius: 2px;
    background: rgb(var(--ink-rgb) / 0.1);
    overflow: hidden;
  }
  .bar div {
    height: 100%;
    background: var(--accent);
    transform-origin: left;
  }
  .tabs {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
  }
  .tabs button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 6px 0 4px;
    color: var(--ink-3);
    font-size: 11px;
    font-weight: 600;
    transition: color var(--t-fast);
  }
  .tabs button.on {
    color: var(--ink);
  }
  .ico {
    position: relative;
    width: 52px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: var(--r-pill);
    transition: background var(--t-fast);
  }
  .tabs button.on .ico {
    background: rgb(var(--accent-rgb) / 0.18);
    color: var(--accent);
  }
  .ico img {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    object-fit: cover;
  }
  .badge {
    position: absolute;
    top: -2px;
    right: 6px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 8px;
    font-size: 10px;
    line-height: 16px;
    color: var(--on-accent);
    background: var(--accent);
  }
</style>
