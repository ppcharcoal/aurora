<script lang="ts">
  import { preview } from "../preview.svelte";
  import Icon from "./Icon.svelte";

  // Round "listen" button with a progress ring. Used on search results,
  // album tracks, Discover, friends and sync rows.
  let { key, src, size = 32, label = "Preview" }: { key: string; src: () => Promise<string>; size?: number; label?: string } = $props();
  const active = $derived(preview.key === key);
  const C = 2 * Math.PI * 15;
</script>

<button
  class="pv"
  class:active
  style:width={`${size}px`}
  style:height={`${size}px`}
  onclick={(e) => {
    e.stopPropagation();
    preview.toggle(key, src);
  }}
  aria-label={active ? "Stop preview" : label}
  title={active ? "Stop preview" : `${label} (30 s)`}
>
  <svg viewBox="0 0 34 34" aria-hidden="true">
    <circle cx="17" cy="17" r="15" class="track" />
    {#if active}
      <circle cx="17" cy="17" r="15" class="ring" class:spin={preview.loading} style:stroke-dashoffset={preview.loading ? C * 0.75 : C * (1 - preview.progress)} style:stroke-dasharray={C} />
    {/if}
  </svg>
  <span class="glyph"><Icon name={active && !preview.loading ? "pause" : "headphones"} size={Math.round(size * 0.45)} /></span>
</button>

<style>
  .pv {
    position: relative;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--ink-2);
    background: var(--well);
    transition:
      color var(--t-fast),
      transform var(--t-fast) var(--ease-out);
  }
  .pv:hover {
    color: var(--ink);
  }
  .pv:active {
    transform: scale(0.92);
  }
  .pv.active {
    color: var(--accent);
  }
  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
  }
  circle {
    fill: none;
    stroke-width: 2.5;
  }
  .track {
    stroke: transparent;
  }
  .ring {
    stroke: var(--accent);
    stroke-linecap: round;
    transition: stroke-dashoffset 250ms linear;
  }
  .ring.spin {
    transform-origin: 17px 17px;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .glyph {
    position: relative;
    display: grid;
  }
</style>
