<script lang="ts">
  // A record: grooves are one repeating gradient, the label is the cover art.
  // Spinning is a single compositor-only rotation (33⅓ rpm = 1.8 s per turn).
  let { art, spinning = false, size = "100%" }: { art?: string; spinning?: boolean; size?: string } = $props();
</script>

<div class="vinyl" class:spinning style:width={size} style:height={size} aria-hidden="true">
  <div class="disc">
    <div class="label" style:background-image={art ? `url("${art}")` : undefined}></div>
    <div class="hole"></div>
  </div>
</div>

<style>
  .vinyl {
    flex: none;
    border-radius: 50%;
    filter: drop-shadow(0 6px 14px rgb(0 0 0 / 0.35));
  }
  .disc {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background:
      radial-gradient(circle, transparent 0 33%, rgb(255 255 255 / 0.06) 33.5% 34%, transparent 34.5%),
      repeating-radial-gradient(circle, var(--vinyl) 0 1.2px, #23202a 1.6px 2.2px),
      var(--vinyl);
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.12);
    animation: spin 1.8s linear infinite;
    animation-play-state: paused;
  }
  /* Light catching the grooves. */
  .disc::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: conic-gradient(from 30deg, transparent 0 12%, rgb(255 255 255 / 0.12) 18%, transparent 26% 62%, rgb(255 255 255 / 0.08) 68%, transparent 76%);
  }
  .spinning .disc {
    animation-play-state: running;
  }
  .label {
    position: absolute;
    inset: 32%;
    border-radius: 50%;
    background: var(--accent) center / cover;
  }
  .hole {
    position: absolute;
    inset: 48.5%;
    border-radius: 50%;
    background: var(--night);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  :global(:root[data-reduce-motion="true"]) .disc {
    animation: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .disc {
      animation: none;
    }
  }
</style>
