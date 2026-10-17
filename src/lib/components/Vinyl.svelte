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
    /* Its own layer: turning it only moves pixels instead of redrawing the
       grooves every frame (a big saving on Linux / WebKitGTK). */
    will-change: transform;
    transform: translateZ(0);
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
  /* Both ends spelled out with the same functions: with only `to`, the start
     is the resting translateZ(0), and translateZ(0) → rotate(360deg) is
     interpolated as matrices (identity → identity), so it never turned. */
  @keyframes spin {
    from {
      transform: rotate(0deg) translateZ(0);
    }
    to {
      transform: rotate(360deg) translateZ(0);
    }
  }
  :global(:root[data-reduce-motion="true"]) .disc {
    animation: none;
  }
  /* Linux app: only Aurora's own setting counts (see app.css). */
  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-shell="electron"])) .disc {
      animation: none;
    }
  }
</style>
