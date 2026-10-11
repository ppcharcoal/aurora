<script lang="ts">
  import { fade, fly } from "svelte/transition";
  import { time } from "../format";
  import { lastfm } from "../lastfm.svelte";
  import { trackMenu } from "../menus";
  import { iconFor, output } from "../output.svelte";
  import { player } from "../player.svelte";
  import { settings } from "../settings.svelte";
  import { ui } from "../ui.svelte";
  import Artwork from "./Artwork.svelte";
  import Icon from "./Icon.svelte";
  import OutputPicker from "./OutputPicker.svelte";
  import Slider from "./Slider.svelte";
  import Vinyl from "./Vinyl.svelte";

  // Phone: the full-screen player. Swipe down (or the chevron) to close.
  const t = $derived(player.current);
  const m = $derived(settings.value.reduceMotion ? 0 : 1);
  let picking = $state(false);

  let startY: number | null = null;
  let drag = $state(0);
  function down(e: PointerEvent) {
    startY = e.clientY;
  }
  function move(e: PointerEvent) {
    if (startY !== null) drag = Math.max(0, e.clientY - startY);
  }
  function up() {
    if (drag > 110) ui.sheetOpen = false;
    startY = null;
    drag = 0;
  }

  $effect(() => {
    if (!t) ui.sheetOpen = false;
  });
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && (ui.sheetOpen = false)} />

{#if t}
  <div
    class="sheet"
    style:transform={drag ? `translateY(${drag}px)` : undefined}
    class:dragging={drag > 0}
    transition:fly={{ y: 600 * m, duration: 380 * m, opacity: 1 }}
  >
    <div class="glow" style:background-image={t.art ? `url("${t.art}")` : undefined}></div>
    <header role="presentation" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}>
      <button class="x" onclick={() => (ui.sheetOpen = false)} aria-label="Close the player"><Icon name="chevron" size={22} /></button>
      <span>Now playing</span>
      <button class="x" onclick={(e) => ui.openMenu(e, trackMenu(t))} aria-label="More"><Icon name="more" size={20} /></button>
    </header>

    <div class="art" role="presentation" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}>
      <div class="record" class:out={player.playing}><Vinyl art={t.art} spinning={player.playing} size="100%" /></div>
      <div class="sleeve"><Artwork src={t.art} size="100%" radius="14px" eager /></div>
    </div>

    <div class="info">
      <div class="names">
        {#key t.key}
          <div class="title" in:fade={{ duration: 200 * m }}>{t.title}</div>
        {/key}
        <div class="artist">{t.artist}</div>
      </div>
      <button class="heart" class:on={lastfm.isLoved(t)} onclick={() => lastfm.toggleLove(t)} aria-label={lastfm.isLoved(t) ? "Unlove" : "Love"}>
        <Icon name={lastfm.isLoved(t) ? "heartFill" : "heart"} size={24} />
      </button>
    </div>

    <div class="seek">
      <Slider label="Seek" value={player.position} max={player.duration || 1} glide={player.playing} format={time} onchange={(v) => player.seek(v)} />
      <div class="times"><span>{time(player.position)}</span><span>{time(player.duration)}</span></div>
    </div>

    <div class="controls">
      <button class="sm" class:on={player.shuffle} onclick={() => player.toggleShuffle()} aria-label="Shuffle"><Icon name="shuffle" size={21} /></button>
      <button class="md" onclick={() => player.prev()} aria-label="Previous"><Icon name="prev" size={28} /></button>
      <button class="play" class:loading={player.loading} onclick={() => player.toggle()} aria-label={player.playing ? "Pause" : "Play"}>
        <Icon name={player.playing ? "pause" : "play"} size={30} />
      </button>
      <button class="md" onclick={() => player.next()} aria-label="Next"><Icon name="next" size={28} /></button>
      <button class="sm" class:on={player.repeat !== "off"} onclick={() => player.cycleRepeat()} aria-label="Repeat">
        <Icon name="repeat" size={21} />{#if player.repeat === "one"}<b>1</b>{/if}
      </button>
    </div>

    <div class="foot">
      <button class="pill" class:on={!!output.active} onclick={() => (picking = true)}>
        <Icon name={output.active ? iconFor(output.active.kind) : "output"} size={17} />
        <span>{output.active?.label ?? "This phone"}</span>
      </button>
      <button class="pill" onclick={() => (ui.queueOpen = true)}><Icon name="queue" size={17} /><span>Queue</span></button>
    </div>
  </div>

  {#if picking}
    <div class="scrim" role="presentation" onclick={() => (picking = false)} transition:fade={{ duration: 150 * m }}></div>
    <div class="picker" transition:fly={{ y: 300 * m, duration: 280 * m, opacity: 1 }}>
      <h2>Play on</h2>
      <OutputPicker />
      <p class="note">In the car, Android Auto always plays through the car.</p>
      <button class="btn" onclick={() => (picking = false)}>Done</button>
    </div>
  {/if}
{/if}

<style>
  .sheet {
    position: fixed;
    inset: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    padding: calc(var(--safe-top) + 6px) 22px calc(var(--safe-bottom) + 18px);
    background: var(--panel-solid);
    overflow: hidden;
    touch-action: none;
  }
  .sheet:not(.dragging) {
    transition: transform 220ms var(--ease-out);
  }
  .glow {
    position: absolute;
    inset: -20%;
    z-index: -1;
    background-size: cover;
    background-position: center;
    filter: blur(60px) saturate(1.4);
    opacity: 0.45;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 48px;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink-2);
  }
  .x {
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border-radius: 50%;
  }
  .x :global(svg) {
    transform: rotate(90deg);
  }
  .x:last-child :global(svg) {
    transform: none;
  }
  .art {
    position: relative;
    width: min(100%, 46vh);
    aspect-ratio: 1;
    margin: 4vh auto 0;
  }
  .sleeve,
  .record {
    position: absolute;
    inset: 0;
  }
  .sleeve {
    box-shadow: 0 24px 60px rgb(0 0 0 / 0.45);
    border-radius: 14px;
  }
  .record {
    inset: 4%;
    transition: transform 700ms var(--ease-out);
  }
  .record.out {
    transform: translateY(-14%);
  }
  .info {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: auto;
    padding-top: 22px;
  }
  .names {
    flex: 1;
    min-width: 0;
  }
  .title {
    font: 700 24px var(--font-display);
    font-variation-settings: "wdth" 85;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .artist {
    color: var(--ink-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .heart {
    width: 46px;
    height: 46px;
    display: grid;
    place-items: center;
    color: var(--ink-2);
  }
  .heart.on {
    color: #ff5d8f;
  }
  .seek {
    margin-top: 14px;
  }
  .times {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }
  .controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 14px 0 18px;
  }
  .controls button {
    position: relative;
    display: grid;
    place-items: center;
    border-radius: 50%;
  }
  .sm {
    width: 48px;
    height: 48px;
    color: var(--ink-2);
  }
  .sm.on {
    color: var(--accent);
  }
  .sm b {
    position: absolute;
    top: 8px;
    right: 8px;
    font-size: 10px;
  }
  .md {
    width: 60px;
    height: 60px;
  }
  .play {
    width: 76px;
    height: 76px;
    color: var(--on-accent);
    background: var(--accent);
    box-shadow: 0 10px 30px rgb(var(--accent-rgb) / 0.35);
  }
  .play:active,
  .md:active {
    transform: scale(0.94);
  }
  .play.loading {
    animation: pulse 1s ease-in-out infinite alternate;
  }
  @keyframes pulse {
    to {
      opacity: 0.7;
    }
  }
  .foot {
    display: flex;
    justify-content: space-between;
    gap: 10px;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    height: 38px;
    padding: 0 14px;
    border-radius: var(--r-pill);
    background: rgb(var(--ink-rgb) / 0.08);
    font-size: 13px;
    font-weight: 600;
  }
  .pill span {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pill.on {
    color: var(--accent);
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 31;
    background: rgb(0 0 0 / 0.45);
  }
  .picker {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 32;
    max-height: 80vh;
    overflow: auto;
    padding: 20px 18px calc(var(--safe-bottom) + 18px);
    border-radius: 22px 22px 0 0;
    background: var(--panel-solid);
    box-shadow: var(--shadow);
  }
  .picker h2 {
    font-size: 20px;
    margin: 0 0 12px;
  }
  .note {
    font-size: 12px;
    color: var(--ink-3);
  }
</style>
