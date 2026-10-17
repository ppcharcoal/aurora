<script lang="ts">
  import { fade } from "svelte/transition";
  import { player } from "../player.svelte";
  import { settings } from "../settings.svelte";
  import { theme } from "../theme.svelte";

  // Three backgrounds:
  //  cover — the current cover, blurred into a slow-moving aurora
  //  image — your own picture (Settings → Appearance)
  //  plain — flat base colour with a faint aurora wash
  // Performance: the blurred layer is rendered small and scaled up on the GPU,
  // so the blur is cheap and the drift animation only touches `transform`.
  const art = $derived(theme.background === "cover" ? (player.current?.art ?? null) : null);
  const m = $derived(settings.value.reduceMotion ? 0 : 1);
</script>

<div class="ambient" aria-hidden="true">
  <div class="aurora"></div>
  {#if theme.background === "image" && theme.wallpaperSrc}
    {#key theme.wallpaperSrc}
      <div class="wall" style:background-image={`url("${theme.wallpaperSrc}")`} transition:fade={{ duration: 700 * m }}></div>
    {/key}
  {/if}
  {#if art}
    {#key art}
      <div class="layer" transition:fade={{ duration: 1100 * m }}>
        <div class="blur" style:background-image={`url("${art}")`}></div>
      </div>
    {/key}
  {/if}
  <div class="veil" class:on-image={theme.background === "image"}></div>
</div>

<style>
  .ambient {
    position: fixed;
    inset: 0;
    z-index: 0;
    overflow: hidden;
    pointer-events: none;
    contain: strict;
    background: var(--night);
  }
  /* Two soft aurora bands; always there, faint behind everything. */
  .aurora {
    position: absolute;
    inset: -20%;
    background:
      radial-gradient(40% 35% at 22% 18%, rgb(157 123 255 / 0.2), transparent 70%),
      radial-gradient(45% 40% at 82% 78%, rgb(var(--accent-rgb) / 0.16), transparent 70%);
  }
  .wall {
    position: absolute;
    inset: -12px;
    background-size: cover;
    background-position: center;
    filter: blur(6px) saturate(1.1);
  }
  .layer {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
  }
  .blur {
    width: 32vw;
    height: 32vh;
    background-size: cover;
    background-position: center;
    filter: blur(16px) saturate(1.6);
    opacity: 0.75;
    transform: scale(3.8);
    will-change: transform;
    animation: drift 46s ease-in-out infinite alternate;
  }
  @keyframes drift {
    0% {
      transform: scale(3.8) rotate(0deg) translate(0, 0);
    }
    50% {
      transform: scale(4.3) rotate(8deg) translate(3%, -4%);
    }
    100% {
      transform: scale(4) rotate(-6deg) translate(-4%, 3%);
    }
  }
  :global(:root[data-reduce-motion="true"]) .blur {
    animation: none;
  }
  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-shell="electron"])) .blur {
      animation: none;
    }
  }
  /* Keeps text readable over any picture, in both modes. */
  .veil {
    position: absolute;
    inset: 0;
    background:
      linear-gradient(180deg, rgb(var(--base-rgb) / 0.2), rgb(var(--base-rgb) / 0.62) 60%, rgb(var(--base-rgb) / 0.86)),
      radial-gradient(120% 90% at 50% 0%, transparent, rgb(var(--base-rgb) / 0.5));
  }
  /* Stronger at the top so the title bar stays readable on bright pictures. */
  .veil.on-image {
    background: linear-gradient(
      180deg,
      rgb(var(--base-rgb) / 0.72) 0,
      rgb(var(--base-rgb) / 0.3) 64px,
      rgb(var(--base-rgb) / 0.4) 70%,
      rgb(var(--base-rgb) / 0.72)
    );
  }
</style>
