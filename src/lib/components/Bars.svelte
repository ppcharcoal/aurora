<script lang="ts">
  // Animated "now playing" equalizer. Pure CSS transforms → compositor only.
  let { paused = false, size = 14 }: { paused?: boolean; size?: number } = $props();
</script>

<span class="bars" class:paused style:height={`${size}px`} aria-label={paused ? "Paused" : "Playing"}>
  <i></i><i></i><i></i>
</span>

<style>
  .bars {
    display: inline-flex;
    align-items: flex-end;
    gap: 2px;
    width: 14px;
  }
  i {
    flex: 1;
    height: 100%;
    border-radius: 2px;
    background: var(--accent);
    transform-origin: bottom;
    animation: eq 0.9s ease-in-out infinite alternate;
  }
  i:nth-child(2) {
    animation-duration: 0.7s;
    animation-delay: -0.3s;
  }
  i:nth-child(3) {
    animation-duration: 1.1s;
    animation-delay: -0.6s;
  }
  .paused i {
    animation-play-state: paused;
  }
  @keyframes eq {
    0% {
      transform: scaleY(0.25);
    }
    100% {
      transform: scaleY(1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-shell="electron"])) i {
      animation: none;
      transform: scaleY(0.6);
    }
  }
</style>
