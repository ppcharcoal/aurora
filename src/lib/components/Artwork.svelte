<script lang="ts">
  import Icon from "./Icon.svelte";

  let {
    src,
    size = 48,
    radius = "var(--r-art)",
    alt = "",
    eager = false,
  }: { src?: string; size?: number | string; radius?: string; alt?: string; eager?: boolean } = $props();

  let loaded = $state(false);
  let failed = $state(false);
  $effect(() => {
    src;
    loaded = false;
    failed = false;
  });

  const dim = $derived(typeof size === "number" ? `${size}px` : size);
</script>

<div class="art" style:width={dim} style:height={dim} style:border-radius={radius}>
  {#if src && !failed}
    <img
      {src}
      {alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      draggable="false"
      class:loaded
      onload={() => (loaded = true)}
      onerror={() => (failed = true)}
    />
  {/if}
  {#if !src || failed}
    <div class="ph"><Icon name="note" size={typeof size === "number" ? Math.max(14, size * 0.36) : 40} /></div>
  {/if}
</div>

<style>
  .art {
    position: relative;
    flex: none;
    overflow: hidden;
    background: linear-gradient(140deg, var(--night-3), var(--night-2));
    aspect-ratio: 1;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity var(--t-med) var(--ease-out);
  }
  img.loaded {
    opacity: 1;
  }
  .ph {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--ink-3);
  }
</style>
