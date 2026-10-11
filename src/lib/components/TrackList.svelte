<script lang="ts">
  import { getContext, onMount } from "svelte";
  import { time } from "../format";
  import { trackMenu } from "../menus";
  import { player } from "../player.svelte";
  import { playlists } from "../playlists.svelte";
  import type { Track } from "../types";
  import { ui } from "../ui.svelte";
  import Artwork from "./Artwork.svelte";
  import Bars from "./Bars.svelte";
  import Icon from "./Icon.svelte";

  // Virtualised list: only the rows in view (+ overscan) exist in the DOM, so a
  // 20 000-song library scrolls as smoothly as a 20-song playlist.
  // Inside a playlist, rows can be dragged to reorder.
  let {
    tracks,
    showAlbum = true,
    playlistId,
  }: {
    tracks: Track[];
    showAlbum?: boolean;
    playlistId?: string;
  } = $props();

  const ROW = 56;
  const OVERSCAN = 8;
  const scroller = getContext<() => HTMLElement | undefined>("scroller");

  let list = $state<HTMLDivElement>();
  let start = $state(0);
  let end = $state(40);
  let dragFrom = $state<number | null>(null);
  let dropAt = $state<number | null>(null);

  function measure() {
    const sc = scroller?.();
    if (!sc || !list) return;
    const top = list.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    const from = sc.scrollTop - top;
    start = Math.max(0, Math.floor(from / ROW) - OVERSCAN);
    end = Math.min(tracks.length, Math.ceil((from + sc.clientHeight) / ROW) + OVERSCAN);
  }

  onMount(() => {
    const sc = scroller?.();
    if (!sc) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(sc);
    measure();
    return () => {
      sc.removeEventListener("scroll", onScroll);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  });

  $effect(() => {
    tracks.length;
    measure();
  });

  const visible = $derived(tracks.slice(start, end));
  const currentKey = $derived(player.current?.key);

  const play = (i: number) => player.playList(tracks, i);
  const menu = (e: MouseEvent, t: Track, i: number) => ui.openMenu(e, trackMenu(t, { playlistId, index: i }));

  /* ---- drag to reorder (playlists only) ---- */
  function dragStart(e: DragEvent, i: number) {
    dragFrom = i;
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", String(i));
  }
  function dragOver(e: DragEvent) {
    if (dragFrom === null || !list) return;
    e.preventDefault();
    const y = e.clientY - list.getBoundingClientRect().top;
    dropAt = Math.max(0, Math.min(tracks.length, Math.round(y / ROW)));
  }
  function drop(e: DragEvent) {
    e.preventDefault();
    if (playlistId && dragFrom !== null && dropAt !== null) {
      const to = dropAt > dragFrom ? dropAt - 1 : dropAt;
      playlists.move(playlistId, dragFrom, to);
    }
    dragFrom = dropAt = null;
  }
</script>

<div class="head" class:noalbum={!showAlbum}>
  <span class="c-num">#</span>
  <span>Title</span>
  {#if showAlbum}<span>Album</span>{/if}
  <span class="c-dur">Time</span>
</div>

<div
  class="list"
  bind:this={list}
  style:height={`${tracks.length * ROW}px`}
  role="list"
  ondragover={dragOver}
  ondrop={drop}
  ondragleave={(e) => e.currentTarget === e.target && (dropAt = null)}
>
  {#each visible as t, k (t.key + ":" + (start + k))}
    {@const i = start + k}
    <!-- Tapping the row plays it on a phone; the # button does the same for keyboards. -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div
      class="row"
      class:noalbum={!showAlbum}
      class:current={t.key === currentKey}
      class:dragging={dragFrom === i}
      style:transform={`translateY(${i * ROW}px)`}
      role="listitem"
      draggable={!!playlistId}
      ondragstart={(e) => dragStart(e, i)}
      ondragend={() => (dragFrom = dropAt = null)}
      ondblclick={() => play(i)}
      onclick={(e) => ui.phone && !(e.target as HTMLElement).closest("button") && play(i)}
      oncontextmenu={(e) => menu(e, t, i)}
    >
      <button class="c-num" onclick={() => play(i)} aria-label={`Play ${t.title}`}>
        {#if t.key === currentKey}
          <Bars paused={!player.playing} />
        {:else}
          <span class="n">{i + 1}</span>
          <span class="p"><Icon name="play" size={14} /></span>
        {/if}
      </button>
      <div class="main">
        <Artwork src={t.art} size={40} radius="6px" />
        <div class="text">
          <div class="title">{t.title}</div>
          <div class="sub">{t.artist}</div>
        </div>
      </div>
      {#if showAlbum}<div class="album">{t.album ?? ""}</div>{/if}
      <div class="c-dur">
        <button class="act" onclick={(e) => menu(e, t, i)} aria-label="More options" title="More options">
          <Icon name="more" size={18} stroke={3} />
        </button>
        <span>{t.durationMs ? time(t.durationMs) : ""}</span>
      </div>
    </div>
  {/each}
  {#if dropAt !== null}
    <div class="drop" style:transform={`translateY(${dropAt * ROW - 1}px)`}></div>
  {/if}
</div>

<style>
  .head,
  .row {
    display: grid;
    grid-template-columns: 44px minmax(0, 3fr) minmax(0, 2fr) 104px;
    align-items: center;
    gap: 14px;
    padding: 0 14px;
  }
  .noalbum {
    grid-template-columns: 44px minmax(0, 1fr) 104px;
  }
  .head {
    height: 36px;
    color: var(--ink-3);
    font-size: 12px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 8px;
  }
  .list {
    position: relative;
    contain: strict;
    width: 100%;
  }
  .row {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 56px;
    border-radius: 10px;
    transition: background var(--t-fast);
  }
  .row:hover {
    background: rgb(var(--ink-rgb) / 0.06);
  }
  .row.current {
    background: rgb(var(--accent-rgb) / 0.1);
  }
  .row.current .title {
    color: var(--accent);
  }
  .row.dragging {
    opacity: 0.4;
  }
  .row[draggable="true"] {
    cursor: grab;
  }
  .drop {
    position: absolute;
    left: 14px;
    right: 14px;
    top: 0;
    height: 2px;
    border-radius: 2px;
    background: var(--accent);
    box-shadow: 0 0 10px rgb(var(--accent-rgb) / 0.7);
    pointer-events: none;
  }
  .c-num {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }
  .c-num .p {
    display: none;
    color: var(--ink);
  }
  .row:hover .c-num .n {
    display: none;
  }
  .row:hover .c-num .p {
    display: grid;
  }
  .main {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .text {
    min-width: 0;
  }
  .title,
  .sub,
  .album {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .title {
    font-weight: 600;
    transition: color var(--t-fast);
  }
  .sub,
  .album {
    color: var(--ink-2);
    font-size: 13px;
  }
  .c-dur {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    color: var(--ink-3);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .act {
    opacity: 0;
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--ink-2);
    transition:
      opacity var(--t-fast),
      background var(--t-fast);
  }
  .row:hover .act,
  .act:focus-visible {
    opacity: 1;
  }
  .act:hover {
    background: rgb(var(--ink-rgb) / 0.1);
    color: var(--ink);
  }

  /* Phone: title and artist get the width; tap a song to play it. */
  :global(html[data-phone]) .head {
    display: none;
  }
  :global(html[data-phone]) .row,
  :global(html[data-phone]) .row.noalbum {
    grid-template-columns: 26px minmax(0, 1fr) auto;
    gap: 8px;
    padding: 0 2px 0 4px;
  }
  :global(html[data-phone]) .album {
    display: none;
  }
  :global(html[data-phone]) .c-num {
    width: 26px;
    font-size: 12px;
  }
  :global(html[data-phone]) .c-dur {
    gap: 2px;
    font-size: 12px;
  }
  :global(html[data-phone]) .act {
    opacity: 1;
    width: 36px;
    height: 40px;
  }
</style>
