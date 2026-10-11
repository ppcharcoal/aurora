<script lang="ts">
  import Artwork from "./Artwork.svelte";
  import Icon from "./Icon.svelte";

  // Playlist cover: one cover, or a 2×2 grid of the first four.
  let { covers, size = "100%", radius = "10px" }: { covers: string[]; size?: number | string; radius?: string } = $props();
  const dim = $derived(typeof size === "number" ? `${size}px` : size);
</script>

{#if covers.length >= 4}
  <div class="mosaic" style:width={dim} style:height={dim === "100%" ? undefined : dim} style:border-radius={radius}>
    {#each covers.slice(0, 4) as c}
      <Artwork src={c} size="100%" radius="0" />
    {/each}
  </div>
{:else if covers.length}
  <Artwork src={covers[0]} {size} {radius} />
{:else}
  <div class="empty" style:width={dim} style:height={dim === "100%" ? undefined : dim} style:border-radius={radius}>
    <Icon name="playlistAdd" size={typeof size === "number" ? Math.max(16, size * 0.3) : 44} stroke={1.5} />
  </div>
{/if}

<style>
  .mosaic {
    display: grid;
    grid-template-columns: 1fr 1fr;
    aspect-ratio: 1;
    overflow: hidden;
    flex: none;
  }
  .empty {
    aspect-ratio: 1;
    flex: none;
    display: grid;
    place-items: center;
    color: var(--ink-3);
    background: linear-gradient(140deg, rgb(157 123 255 / 0.25), rgb(var(--accent-rgb) / 0.15));
  }
</style>
