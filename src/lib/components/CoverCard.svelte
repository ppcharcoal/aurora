<script lang="ts">
  import Artwork from "./Artwork.svelte";
  import Icon from "./Icon.svelte";
  import Vinyl from "./Vinyl.svelte";

  let {
    title,
    subtitle,
    art,
    round = false,
    onopen,
    onplay,
  }: {
    title: string;
    subtitle?: string;
    art?: string;
    round?: boolean;
    onopen: () => void;
    onplay?: () => void;
  } = $props();
</script>

<div class="card">
  <button class="hit" onclick={onopen} aria-label={`Open ${title}`}></button>
  <div class="cover">
    {#if !round}<div class="record"><Vinyl {art} size="100%" /></div>{/if}
    <div class="sleeve"><Artwork src={art} size="100%" radius={round ? "50%" : "10px"} /></div>
    {#if onplay}
      <button class="play" onclick={onplay} aria-label={`Play ${title}`}><Icon name="play" size={18} /></button>
    {/if}
  </div>
  <div class="t">{title}</div>
  {#if subtitle}<div class="s">{subtitle}</div>{/if}
</div>

<style>
  .card {
    position: relative;
    min-width: 0;
    padding: 10px;
    margin: -10px;
    border-radius: 14px;
    transition: background var(--t-fast);
  }
  .card:hover {
    background: rgb(var(--ink-rgb) / 0.05);
  }
  .hit {
    position: absolute;
    inset: 0;
    border-radius: 14px;
    z-index: 2; /* above the sleeve so the whole card is clickable */
  }
  .cover {
    position: relative;
    margin-bottom: 10px;
  }
  .sleeve {
    position: relative;
    z-index: 1;
    border-radius: 10px;
    box-shadow: 6px 0 16px rgb(0 0 0 / 0.22);
    transition: transform var(--t-med) var(--ease-out);
  }
  /* The record slides out of the sleeve on hover. */
  .record {
    position: absolute;
    inset: 4%;
    transition: transform 600ms var(--ease-out);
  }
  .card:hover .record {
    transform: translateX(13%) rotate(50deg);
  }
  .card:hover .sleeve {
    transform: translateX(-3%);
  }
  .play {
    position: absolute;
    z-index: 3;
    right: 10px;
    bottom: 10px;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--on-accent);
    box-shadow: 0 8px 20px rgb(0 0 0 / 0.35);
    opacity: 0;
    transform: translateY(8px) scale(0.9);
    transition:
      opacity var(--t-fast),
      transform var(--t-med) var(--ease-spring);
  }
  .card:hover .play,
  .play:focus-visible {
    opacity: 1;
    transform: none;
  }
  .play:active {
    transform: scale(0.92);
  }
  .t {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .s {
    font-size: 13px;
    color: var(--ink-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
