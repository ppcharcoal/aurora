<script lang="ts">
  import { prettyPath } from "../native";
  import { defaultFolderLabel, isAndroid, sep } from "../platform";
  import { onDestroy } from "svelte";
  import { fade, fly } from "svelte/transition";
  import { downloads } from "../downloads.svelte";
  import { time, totalTime } from "../format";
  import { player } from "../player.svelte";
  import { settings } from "../settings.svelte";
  import type { AlbumResult, Track } from "../types";
  import Icon from "./Icon.svelte";
  import { thumbFallback } from "../ytparse";
  import { approx } from "../format";
  import { preview, previewSource } from "../preview.svelte";
  import PreviewButton from "./PreviewButton.svelte";

  let { album, onclose }: { album: AlbumResult; onclose: () => void } = $props();

  const fromCatalog = $derived(album.id.startsWith("dz:") || album.id.startsWith("it:"));
  const dl = $derived(downloads.albumStatus(album));
  const have = $derived(downloads.albumHave(album));
  const total = $derived(album.tracks.reduce((s, t) => s + t.durationMs, 0));
  const busy = $derived(dl?.status === "queued" || dl?.status === "downloading");
  const m = $derived(settings.value.reduceMotion ? 0 : 1);
  const mineOf = (t: AlbumResult["tracks"][number]) => downloads.trackFor(t.id, { artist: t.artist ?? album.artist, title: t.title, durationMs: t.durationMs });
  const owned = $derived(album.tracks.map(mineOf).filter((t): t is Track => !!t));

  /** Catalog tracks have 30 s clips; YouTube Music tracks stream from the site. */
  const srcOf = (t: AlbumResult["tracks"][number]) => previewSource({ preview: t.preview, id: t.id, streamable: !fromCatalog });
  const previewable = $derived(album.tracks.filter((t) => srcOf(t)));
  const previewingThis = $derived(!!preview.key && album.tracks.some((t) => `${album.id}:${t.id}` === preview.key));
  function previewAll() {
    if (previewingThis) return preview.stop();
    preview.playList(previewable.map((t) => ({ key: `${album.id}:${t.id}`, src: srcOf(t)! })));
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }
  // Closing the dialog stops its preview (runs once, on close). The album
  // prop may already be gone by then, so keep the keys we need.
  let ownKeys: string[] = [];
  $effect(() => {
    if (album) ownKeys = album.tracks.map((t) => `${album.id}:${t.id}`);
  });
  onDestroy(() => {
    if (preview.key && ownKeys.includes(preview.key)) preview.stop();
  });
</script>

<svelte:window onkeydown={onKey} />

<div class="back" role="presentation" onpointerdown={onclose} transition:fade={{ duration: 160 * m }}></div>
<div class="dlg" role="dialog" aria-label={album.title} transition:fly={{ y: 24 * m, duration: 280 * m }}>
  <header>
    <div class="cover">{#if album.thumb}<img src={album.thumb} alt="" onerror={thumbFallback} onload={thumbFallback} />{/if}</div>
    <div class="info">
      <div class="kind">{fromCatalog ? "Album from the music catalog" : "Album on YouTube Music"}</div>
      <h2>{album.title}</h2>
      <p class="muted">{album.artist}{album.year ? `, ${album.year}` : ""} — {album.tracks.length} songs, {totalTime(total)}, {approx(total, settings.value.quality)}</p>
      <div class="acts">
        {#if busy}
          <button class="btn" onclick={() => downloads.cancel(dl!.id)}>
            {dl?.status === "queued" ? "Queued" : `Downloading ${(dl?.completed ?? 0) + 1} of ${album.tracks.length}`} — cancel
          </button>
        {:else if have === album.tracks.length}
          <button class="btn primary" onclick={() => player.playList(owned, 0)}><Icon name="play" size={15} /> Play</button>
        {:else}
          <button class="btn primary" onclick={() => downloads.enqueueAlbum(album)}>
            <Icon name="download" size={15} /> {have ? `Download ${album.tracks.length - have} more` : "Download album"}
          </button>
        {/if}
        {#if previewable.length && have < album.tracks.length}
          <button class="btn" onclick={previewAll}><Icon name={previewingThis ? "pause" : "headphones"} size={15} /> {previewingThis ? "Stop preview" : "Preview album"}</button>
        {/if}
        <button class="btn" onclick={onclose}>Close</button>
      </div>
      {#if busy}
        <div class="rail"><div class="fill" style:transform={`scaleX(${(dl?.percent ?? 0) / 100})`}></div></div>
      {/if}
    </div>
  </header>

  <ol class="tracks">
    {#each album.tracks as t, i (t.id + i)}
      {@const mine = mineOf(t)}
      {@const now = dl?.currentVideo === t.id}
      <li class:now class:mine={!!mine}>
        <span class="n">
          {#if mine}<Icon name="check" size={15} stroke={2.4} />{:else}{i + 1}{/if}
        </span>
        <span class="tt">{t.title}{#if t.artist}<span class="feat"> — {t.artist}</span>{/if}</span>
        <span class="d">{t.durationMs ? time(t.durationMs) : ""}</span>
        {#if !mine && srcOf(t)}<PreviewButton key={`${album.id}:${t.id}`} src={srcOf(t)!} size={28} />{:else}<span></span>{/if}
      </li>
    {/each}
  </ol>
  <p class="note muted">Saved to {settings.value.downloadFolder ? prettyPath(settings.value.downloadFolder) : defaultFolderLabel}{sep}{album.artist} - {album.title}, tagged with album, track numbers and cover.</p>
</div>

<style>
  .back {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: rgb(10 8 14 / 0.6);
  }
  .dlg {
    position: fixed;
    z-index: 41;
    left: 50%;
    top: 50%;
    translate: -50% -50%;
    width: min(720px, calc(100vw - 48px));
    max-height: calc(100vh - 96px);
    display: flex;
    flex-direction: column;
    border-radius: 20px;
    background: var(--night-2);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  header {
    display: flex;
    gap: 22px;
    padding: 24px;
    align-items: flex-end;
    background: linear-gradient(180deg, rgb(var(--accent-rgb) / 0.12), transparent);
  }
  .cover {
    width: 168px;
    aspect-ratio: 1;
    flex: none;
    border-radius: 12px;
    overflow: hidden;
    background: var(--night-3);
    box-shadow: var(--shadow);
  }
  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .info {
    min-width: 0;
    flex: 1;
  }
  .kind {
    font-size: 12px;
    color: var(--ink-3);
  }
  h2 {
    font-size: 34px;
    font-variation-settings: "wdth" 80;
    margin: 4px 0 6px;
    overflow-wrap: anywhere;
  }
  .acts {
    display: flex;
    gap: 10px;
    margin-top: 14px;
  }
  .rail {
    margin-top: 12px;
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
  .tracks {
    list-style: none;
    margin: 0;
    padding: 6px 14px;
    overflow-y: auto;
  }
  li {
    display: grid;
    grid-template-columns: 32px 1fr auto 28px;
    gap: 12px;
    align-items: center;
    height: 42px;
    padding: 0 10px;
    border-radius: 8px;
  }
  li:hover {
    background: rgb(var(--ink-rgb) / 0.05);
  }
  li:has(:global(.pv.active)) {
    background: rgb(var(--accent-rgb) / 0.1);
  }
  li.now {
    background: rgb(var(--accent-rgb) / 0.12);
  }
  .n {
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
    text-align: center;
    display: grid;
    place-items: center;
  }
  li.mine .n {
    color: var(--accent);
  }
  .tt {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 600;
  }
  .feat {
    font-weight: 400;
    color: var(--ink-2);
  }
  .d {
    color: var(--ink-3);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .note {
    font-size: 12px;
    padding: 10px 24px 16px;
    margin: 0;
    border-top: 1px solid var(--line);
  }

  /* Phone: a sheet with the cover next to a short header, buttons below. */
  :global(html[data-phone]) .dlg {
    width: calc(100vw - 20px);
    max-height: calc(100vh - var(--safe-top, 0px) - var(--safe-bottom, 0px) - 40px);
  }
  :global(html[data-phone]) header {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    gap: 14px;
    padding: 16px;
    align-items: center;
  }
  :global(html[data-phone]) .cover {
    width: 96px;
  }
  :global(html[data-phone]) h2 {
    font-size: 24px;
    overflow-wrap: normal;
    word-break: normal;
    hyphens: auto;
  }
  :global(html[data-phone]) header {
    align-items: start;
  }
  :global(html[data-phone]) .acts {
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }
  :global(html[data-phone]) .acts :global(.btn) {
    flex: 1 1 auto;
    justify-content: center;
  }
  :global(html[data-phone]) .tracks {
    padding: 4px 6px;
  }
  :global(html[data-phone]) li {
    grid-template-columns: 26px minmax(0, 1fr) auto 28px;
    gap: 8px;
    padding: 0 6px;
  }
</style>
