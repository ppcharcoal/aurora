<script lang="ts">
  import { downloads } from "../downloads.svelte";
  import { player } from "../player.svelte";
  import type { CatalogTrack } from "../types";
  import Icon from "./Icon.svelte";
  import PreviewButton from "./PreviewButton.svelte";
  import { previewSource } from "../preview.svelte";

  // A catalog song you don't have yet: cover, title, one action.
  let { t }: { t: CatalogTrack } = $props();
  const dl = $derived(downloads.status(t.id));
  const have = $derived(downloads.trackFor(t.id, t));
  const busy = $derived(dl && (dl.status === "queued" || dl.status === "downloading" || dl.status === "converting"));
</script>

<article class="cc">
  <div class="cover">
    {#if t.cover}<img src={t.cover} alt="" loading="lazy" decoding="async" draggable="false" />{/if}
    {#if have}
      <button class="fab" onclick={() => player.playList([have], 0)} aria-label={`Play ${t.title}`}><Icon name="play" size={18} /></button>
    {:else if busy}
      <div class="prog"><div style:transform={`scaleX(${(dl?.percent ?? 0) / 100})`}></div></div>
    {:else}
      <button class="fab" onclick={() => downloads.enqueueCatalog(t)} aria-label={`Download ${t.title}`} title="Download"><Icon name="download" size={18} /></button>
    {/if}
  </div>
  {#if !have && t.preview}<div class="pvw"><PreviewButton key={t.id} src={previewSource({ preview: t.preview })!} size={30} /></div>{/if}
  <div class="t" title={t.title}>{t.title}</div>
  <div class="a">{t.artist}</div>
</article>

<style>
  .cc {
    min-width: 0;
  }
  .cover {
    position: relative;
    aspect-ratio: 1;
    border-radius: 10px;
    overflow: hidden;
    margin-bottom: 10px;
    background: var(--night-3);
  }
  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform var(--t-med) var(--ease-out);
  }
  .cc:hover img {
    transform: scale(1.04);
  }
  .fab {
    position: absolute;
    right: 10px;
    bottom: 10px;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--on-accent);
    box-shadow: 0 8px 20px rgb(0 0 0 / 0.3);
    opacity: 0;
    transform: translateY(8px) scale(0.9);
    transition:
      opacity var(--t-fast),
      transform var(--t-med) var(--ease-spring);
  }
  .cc:hover .fab,
  .fab:focus-visible {
    opacity: 1;
    transform: none;
  }
  .cc {
    position: relative;
  }
  .pvw {
    position: absolute;
    top: 8px;
    left: 8px;
  }
  .pvw :global(.pv) {
    background: rgb(0 0 0 / 0.55);
    color: #fff;
  }
  .prog {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 4px;
    background: rgb(0 0 0 / 0.5);
  }
  .prog div {
    height: 100%;
    background: var(--accent);
    transform-origin: left;
    transition: transform 300ms linear;
  }
  .t,
  .a {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t {
    font-weight: 600;
  }
  .a {
    font-size: 13px;
    color: var(--ink-2);
  }
</style>
