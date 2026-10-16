<script lang="ts">
  import { prettyPath } from "../native";
  import { defaultFolderLabel, isAndroid } from "../platform";
  import { flip } from "svelte/animate";
  import { fly } from "svelte/transition";
  import { revealItemInDir, openPath } from "@tauri-apps/plugin-opener";
  import { downloads } from "../downloads.svelte";
  import { player } from "../player.svelte";
  import { playlists } from "../playlists.svelte";
  import { settings } from "../settings.svelte";
  import { library } from "../sources/local.svelte";
  import { ui } from "../ui.svelte";
  import Icon from "../components/Icon.svelte";
  import type { Track } from "../types";
  import LastfmSync from "../components/LastfmSync.svelte";

  let { tab: initialTab = "queue" }: { tab?: "queue" | "lastfm" } = $props();
  let tab = $state<"queue" | "lastfm">("queue");
  $effect(() => {
    tab = initialTab;
  });

  const label: Record<string, string> = {
    queued: "Waiting",
    downloading: "Downloading",
    converting: "Converting to MP3",
    done: "Saved",
    error: "Failed",
    canceled: "Canceled",
  };
  const finished = $derived(downloads.items.filter((i) => ["done", "error", "canceled"].includes(i.status)).length);
</script>

<div class="page">
  <div class="top">
    <h1 class="page-title">Downloads</h1>
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected={tab === "queue"} class:on={tab === "queue"} onclick={() => (tab = "queue")}>
        Queue{#if downloads.active}<small>{downloads.active}</small>{/if}
      </button>
      <button role="tab" aria-selected={tab === "lastfm"} class:on={tab === "lastfm"} onclick={() => (tab = "lastfm")}>From Last.fm</button>
      <span class="ink" style:transform={tab === "queue" ? "translateX(0)" : "translateX(100%)"}></span>
    </div>
    <div class="tools" class:hide={tab !== "queue"}>
      {#if settings.value.downloadFolder && !isAndroid}
        <button class="btn" onclick={() => openPath(settings.value.downloadFolder).catch(ui.error)}><Icon name="reveal" size={15} /> Open folder</button>
      {/if}
      <button class="btn" onclick={() => downloads.clearFinished()} disabled={!finished}>Clear finished</button>
    </div>
  </div>

  {#if tab === "lastfm"}
    <LastfmSync />
  {:else}
  {#if !downloads.items.length}
    <div class="empty">
      <h2>No downloads this session</h2>
      <p>Search for a song, press Download, and follow its progress here. Finished songs go to {settings.value.downloadFolder ? prettyPath(settings.value.downloadFolder) : defaultFolderLabel} and show up in your library.</p>
      <button class="btn primary" onclick={() => ui.go({ name: "search" })}><Icon name="search" size={16} /> Search YouTube</button>
    </div>
  {/if}

  <div class="list">
    {#each downloads.items as d (d.id)}
      {@const t = d.path ? library.trackAt(d.path) : undefined}
      {@const albumTracks = d.kind === "album" ? (d.paths ?? []).map((p) => library.trackAt(p)).filter((x) => !!x) : []}
      <div class="dl {d.status}" class:album={d.kind === "album" || !!d.catalog} animate:flip={{ duration: 260 }} in:fly={{ y: -10, duration: 260 }}>
        <img class="th" src={d.thumb} alt="" loading="lazy" />
        <div class="info">
          <div class="t">{#if d.kind === "album"}<span class="tag">Album</span>{/if}{d.title}</div>
          <div class="a">{d.artist}{d.playlistId && playlists.get(d.playlistId) ? `, into “${playlists.get(d.playlistId)!.name}”` : ""}{d.kind === "album" ? ` — ${d.album?.tracks.length} songs` : ""}</div>
          <div class="status">
            <span class="st">{label[d.status]}</span>
            {#if d.kind === "album" && d.status === "downloading"}
              <span class="num">song {(d.completed ?? 0) + (d.failed ?? 0) + 1} of {d.album?.tracks.length}{d.current ? `: ${d.current}` : ""}{d.speed ? ` · ${d.speed}` : ""}</span>
            {:else if d.kind === "album" && d.status === "done"}
              <span class="num">{d.completed} songs</span>
            {:else if d.status === "downloading" && d.current}
              <span class="num">{d.current}…</span>
            {:else if d.status === "downloading"}
              <span class="num">{d.percent.toFixed(0)}%{d.speed ? ` · ${d.speed}` : ""}{d.eta && d.eta !== "Unknown" ? ` · ${d.eta} left` : ""}</span>
            {/if}
            {#if d.retry && (d.status === "downloading" || d.status === "converting")}<span class="num retry">{d.retry}…</span>{/if}
            {#if d.error}<span class="err" title={d.error}>{d.error}</span>{/if}
          </div>
          {#if d.status === "downloading" || d.status === "converting" || d.status === "queued"}
            <div class="rail" class:indeterminate={d.status !== "downloading"}>
              <div class="fill" style:transform={d.status === "downloading" ? `scaleX(${d.percent / 100})` : undefined}></div>
            </div>
          {/if}
        </div>
        <div class="acts">
          {#if d.status === "done" && d.kind === "album" && albumTracks.length}
            <button class="icon" onclick={() => player.playList(albumTracks as Track[], 0)} aria-label="Play" title="Play"><Icon name="play" size={16} /></button>
            {#if !isAndroid}<button class="icon" onclick={() => revealItemInDir(d.paths![0]).catch(ui.error)} aria-label="Show in folder" title="Show in folder"><Icon name="reveal" size={16} /></button>{/if}
          {:else if d.status === "done" && t}
            <button class="icon" onclick={() => player.playList([t], 0)} aria-label="Play" title="Play"><Icon name="play" size={16} /></button>
            {#if !isAndroid}<button class="icon" onclick={() => revealItemInDir(d.path!).catch(ui.error)} aria-label="Show in folder" title="Show in folder"><Icon name="reveal" size={16} /></button>{/if}
          {:else if d.status === "error" || d.status === "canceled"}
            <button class="icon" onclick={() => downloads.retry(d.id)} aria-label="Retry" title="Retry"><Icon name="refresh" size={16} /></button>
          {:else}
            <button class="icon" onclick={() => downloads.cancel(d.id)} aria-label="Cancel" title="Cancel"><Icon name="x" size={16} /></button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}
</div>

<style>
  .top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
  }
  .tabs {
    position: relative;
    display: grid;
    grid-template-columns: 1fr 1fr;
    padding: 4px;
    margin: 10px auto 0 24px;
    border-radius: var(--r-pill);
    background: var(--well);
  }
  .tabs button {
    position: relative;
    z-index: 1;
    height: 32px;
    padding: 0 18px;
    border-radius: var(--r-pill);
    font-weight: 600;
    color: var(--ink-2);
    white-space: nowrap;
    transition: color var(--t-fast);
  }
  .tabs button.on {
    color: var(--night);
  }
  .tabs small {
    margin-left: 6px;
    font-weight: 700;
    color: var(--accent);
  }
  .tabs .ink {
    position: absolute;
    top: 4px;
    bottom: 4px;
    left: 4px;
    width: calc(50% - 4px);
    border-radius: var(--r-pill);
    background: var(--ink);
    transition: transform var(--t-med) var(--ease-spring);
  }
  .tools.hide {
    visibility: hidden;
  }
  .tools {
    display: flex;
    gap: 10px;
    margin-top: 8px;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 900px;
  }
  .dl {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px;
    border-radius: 14px;
    background: rgb(var(--ink-rgb) / 0.04);
    border: 1px solid var(--line);
    transition:
      border-color var(--t-med),
      background var(--t-med);
  }
  .dl.album .th {
    width: 63px;
    aspect-ratio: 1;
    margin: 0 24px 0 25px;
  }
  .tag {
    font-size: 11px;
    font-weight: 700;
    padding: 1px 7px;
    margin-right: 8px;
    border-radius: 6px;
    vertical-align: 2px;
    color: var(--night);
    background: var(--accent);
  }
  .dl.done {
    border-color: rgb(var(--accent-rgb) / 0.3);
  }
  .dl.error {
    border-color: rgb(255 110 110 / 0.35);
  }
  .dl.canceled {
    opacity: 0.6;
  }
  .th {
    width: 112px;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    border-radius: 8px;
    flex: none;
    background: var(--night-3);
  }
  .info {
    flex: 1;
    min-width: 0;
  }
  .t {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .a {
    font-size: 13px;
    color: var(--ink-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status {
    display: flex;
    gap: 10px;
    font-size: 12px;
    margin-top: 4px;
    color: var(--ink-3);
    min-width: 0;
  }
  .done .st {
    color: var(--accent);
  }
  .error .st,
  .err {
    color: var(--danger);
  }
  .err {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .retry {
    color: var(--warn);
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .rail {
    position: relative;
    margin-top: 8px;
    height: 4px;
    border-radius: 4px;
    background: rgb(var(--ink-rgb) / 0.1);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transform-origin: left;
    transition: transform 300ms linear;
  }
  .indeterminate .fill {
    width: 35%;
    animation: slide 1.2s ease-in-out infinite;
  }
  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(300%);
    }
  }
  .acts {
    display: flex;
    gap: 4px;
  }
  .icon {
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--ink-2);
  }
  .icon:hover {
    background: rgb(var(--ink-rgb) / 0.08);
    color: var(--ink);
  }

  /* Phone: tabs get their own row; smaller pictures. */
  :global(html[data-phone]) .top {
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin-bottom: 12px;
  }
  :global(html[data-phone]) .tabs {
    order: 3;
    flex: 1 1 100%;
    margin: 0;
  }
  :global(html[data-phone]) .tabs button {
    padding: 0 10px;
  }
  :global(html[data-phone]) .tools {
    margin: 0;
  }
  :global(html[data-phone]) .tools.hide {
    display: none;
  }
  :global(html[data-phone]) .tools .btn {
    height: 34px;
    padding: 0 12px;
    font-size: 13px;
  }
  :global(html[data-phone]) .dl {
    gap: 12px;
    padding: 8px;
  }
  :global(html[data-phone]) .th {
    width: 72px;
  }
  :global(html[data-phone]) .dl.album .th {
    width: 48px;
    margin: 0 12px;
  }
  :global(html[data-phone]) .status {
    flex-wrap: wrap;
    gap: 2px 8px;
  }
  :global(html[data-phone]) .err {
    white-space: normal;
    overflow-wrap: anywhere;
  }
</style>
