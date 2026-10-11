<script lang="ts">
  // A pointer-driven slider. While playing, the fill glides between ticks with a
  // linear transition equal to the tick interval, so we only update state ~4×/s
  // but the bar still moves smoothly.
  let {
    value,
    max = 1,
    glide = false,
    label,
    format,
    onchange,
    oninput,
  }: {
    value: number;
    max?: number;
    glide?: boolean;
    label: string;
    format?: (v: number) => string;
    onchange: (v: number) => void;
    oninput?: (v: number) => void;
  } = $props();

  let el = $state<HTMLDivElement>()!;
  let dragging = $state(false);
  let dragValue = $state(0);
  let hoverX = $state<number | null>(null);

  const shown = $derived(dragging ? dragValue : value);
  const ratio = $derived(max > 0 ? Math.min(1, Math.max(0, shown / max)) : 0);

  function valueAt(clientX: number) {
    const r = el.getBoundingClientRect();
    return (Math.min(1, Math.max(0, (clientX - r.left) / r.width)) || 0) * max;
  }

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    dragging = true;
    dragValue = valueAt(e.clientX);
    oninput?.(dragValue);
  }
  function move(e: PointerEvent) {
    const r = el.getBoundingClientRect();
    hoverX = e.clientX - r.left;
    if (!dragging) return;
    dragValue = valueAt(e.clientX);
    oninput?.(dragValue);
  }
  function up(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    onchange(valueAt(e.clientX));
  }
  function key(e: KeyboardEvent) {
    const step = max / 20;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") onchange(Math.min(max, value + step));
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") onchange(Math.max(0, value - step));
    else return;
    e.preventDefault();
  }
</script>

<div
  class="slider"
  class:dragging
  class:glide={glide && !dragging}
  bind:this={el}
  role="slider"
  tabindex="0"
  aria-label={label}
  aria-valuemin={0}
  aria-valuemax={max}
  aria-valuenow={Math.round(shown)}
  aria-valuetext={format?.(shown)}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  onpointerleave={() => (hoverX = null)}
  onkeydown={key}
>
  <div class="rail">
    <div class="fill" style:transform={`scaleX(${ratio})`}></div>
  </div>
  <div class="thumb" style:left={`${ratio * 100}%`}></div>
  {#if format && hoverX !== null && el}
    <div class="tip" style:left={`${hoverX}px`}>
      {format(dragging ? dragValue : (Math.min(1, Math.max(0, hoverX / el.clientWidth)) || 0) * max)}
    </div>
  {/if}
</div>

<style>
  .slider {
    position: relative;
    height: 18px;
    display: flex;
    align-items: center;
    cursor: pointer;
    touch-action: none;
    --h: 4px;
  }
  .rail {
    position: relative;
    width: 100%;
    height: var(--h);
    border-radius: 4px;
    background: rgb(var(--ink-rgb) / 0.14);
    overflow: hidden;
    transition: height var(--t-fast) var(--ease-out);
  }
  .fill {
    position: absolute;
    inset: 0;
    transform-origin: left;
    background: linear-gradient(90deg, rgb(var(--accent-rgb) / 0.7), var(--accent));
    box-shadow: 0 0 12px rgb(var(--accent-rgb) / 0.6);
    will-change: transform;
  }
  .glide .fill {
    transition: transform 250ms linear;
  }
  .slider:hover,
  .dragging {
    --h: 6px;
  }
  .thumb {
    position: absolute;
    top: 50%;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: var(--ink);
    box-shadow: 0 2px 8px rgb(0 0 0 / 0.4);
    transform: translate(-50%, -50%) scale(0);
    transition: transform var(--t-fast) var(--ease-spring);
    pointer-events: none;
  }
  .glide .thumb {
    transition:
      transform var(--t-fast) var(--ease-spring),
      left 250ms linear;
  }
  .slider:hover .thumb,
  .dragging .thumb,
  .slider:focus-visible .thumb {
    transform: translate(-50%, -50%) scale(1);
  }
  .tip {
    position: absolute;
    bottom: 22px;
    transform: translateX(-50%);
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    background: var(--glass-strong);
    border: 1px solid var(--line);
    pointer-events: none;
    white-space: nowrap;
  }
</style>
