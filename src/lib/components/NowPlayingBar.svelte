<script lang="ts">
  import { fly, fade } from "svelte/transition";
  import { trackMenu } from "../menus";
  import { lastfm } from "../lastfm.svelte";
  import { time } from "../format";
  import { player } from "../player.svelte";
  import { settings } from "../settings.svelte";
  import { ui } from "../ui.svelte";
  import Artwork from "./Artwork.svelte";
  import Icon from "./Icon.svelte";
  import Slider from "./Slider.svelte";
  import { iconFor, output } from "../output.svelte";
  import type { IconName } from "./Icon.svelte";
  import Vinyl from "./Vinyl.svelte";

  const t = $derived(player.current);
  const vol = $derived(settings.value.volume);

  async function outputMenu(e: MouseEvent) {
    const ev = { ...e, type: "click", currentTarget: e.currentTarget, preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() } as unknown as MouseEvent;
    await output.refresh().catch(() => {});
    const chosen = settings.value.audioOutput?.id ?? null;
    const mark = (on: boolean, i: IconName): IconName => (on ? "check" : i);
    ui.openMenu(ev, [
      { label: "System default", icon: mark(!chosen, "output"), action: () => output.select(null) },
      ...output.devices.map((d) => ({ label: d.label, icon: mark(chosen === d.id, iconFor(d.kind)), action: () => output.select(d) })),
      ...(output.needsAccess ? [{ label: "Show my devices…", icon: "refresh" as IconName, action: () => output.refresh(true) }] : []),
      { divider: true, label: "" },
      { label: "Output settings", icon: "settings" as IconName, action: () => ui.go({ name: "settings" }) },
    ]);
  }
  let lastVol = 0.8;

  function toggleMute() {
    if (vol > 0) {
      lastVol = vol;
      player.setVolume(0);
    } else player.setVolume(lastVol || 0.8);
  }

  const motion = $derived(settings.value.reduceMotion ? 0 : 1);
</script>

<footer class="np">
  <div class="left">
    {#if t}
      {#key t.key}
        <div class="meta" in:fly={{ y: 10 * motion, duration: 380 * motion, delay: 60 * motion }} out:fade={{ duration: 120 * motion }}>
          <div class="deck" class:playing={player.playing} role="presentation" oncontextmenu={(e) => ui.openMenu(e, trackMenu(t))}>
            <div class="record"><Vinyl art={t.art} spinning={player.playing} size="54px" /></div>
            <div class="sleeve"><Artwork src={t.art} size={58} eager /></div>
          </div>
          <div class="text">
            <div class="title" title={t.title}>{t.title}</div>
            <div class="artist"><span title={t.artist}>{t.artist}</span></div>
          </div>
          <button
            class="heart"
            class:on={lastfm.isLoved(t)}
            onclick={() => lastfm.toggleLove(t)}
            aria-label={lastfm.isLoved(t) ? "Unlove" : "Love"}
            aria-pressed={lastfm.isLoved(t)}
            title={lastfm.connected && lastfm.cfg.syncLoved ? "Love (synced with Last.fm)" : "Love"}
          >
            <Icon name={lastfm.isLoved(t) ? "heartFill" : "heart"} size={17} />
          </button>
        </div>
      {/key}
    {:else}
      <div class="idle muted">Pick something to play</div>
    {/if}
  </div>

  <div class="center">
    <div class="buttons">
      <button class="icon" class:on={player.shuffle} onclick={() => player.toggleShuffle()} aria-label="Shuffle" aria-pressed={player.shuffle}>
        <Icon name="shuffle" size={17} />
      </button>
      <button class="icon" onclick={() => player.prev()} aria-label="Previous"><Icon name="prev" size={19} /></button>
      <button class="play" class:loading={player.loading} onclick={() => player.toggle()} aria-label={player.playing ? "Pause" : "Play"}>
        {#key player.playing}
          <span class="glyph">
            <Icon name={player.playing ? "pause" : "play"} size={20} />
          </span>
        {/key}
      </button>
      <button class="icon" onclick={() => player.next()} aria-label="Next"><Icon name="next" size={19} /></button>
      <button
        class="icon"
        class:on={player.repeat !== "off"}
        onclick={() => player.cycleRepeat()}
        aria-label={`Repeat: ${player.repeat}`}
      >
        <Icon name="repeat" size={17} />
        {#if player.repeat === "one"}<b class="one">1</b>{/if}
      </button>
    </div>
    <div class="seek">
      <span class="tm">{time(player.position)}</span>
      <Slider
        label="Seek"
        value={player.position}
        max={player.duration || 1}
        glide={player.playing}
        format={time}
        onchange={(v) => player.seek(v)}
      />
      <span class="tm">{time(player.duration)}</span>
    </div>
  </div>

  <div class="right">
    <button class="icon" onclick={toggleMute} aria-label="Mute">
      <Icon name={vol === 0 ? "mute" : vol < 0.5 ? "volumeLow" : "volume"} size={18} />
    </button>
    <div class="vol">
      <Slider label="Volume" value={vol} max={1} oninput={(v) => player.setVolume(v)} onchange={(v) => player.setVolume(v)} />
    </div>
    <button class="icon" class:on={!!output.active} onclick={outputMenu} aria-label="Audio output" title={output.active ? `Playing on ${output.active.label}` : "Audio output"}>
      <Icon name={output.active ? iconFor(output.active.kind) : "output"} size={18} />
    </button>
    <button class="icon" class:on={ui.queueOpen} onclick={() => (ui.queueOpen = !ui.queueOpen)} aria-label="Queue">
      <Icon name="queue" size={18} />
    </button>
  </div>
</footer>

<style>
  /* The dock: a floating panel under the content. */
  .np {
    position: relative;
    z-index: 4;
    margin: var(--gutter);
    border-radius: 22px;
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
    height: 84px;
    display: grid;
    grid-template-columns: minmax(200px, 1fr) minmax(320px, 620px) minmax(200px, 1fr);
    align-items: center;
    gap: 24px;
    padding: 0 18px 0 13px;
    background: var(--glass-strong);
  }
  .left {
    position: relative;
    min-width: 0;
    height: 58px;
  }
  .meta {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }
  .idle {
    line-height: 58px;
  }
  /* Sleeve with the record sliding out of it while playing. */
  .deck {
    position: relative;
    width: 92px;
    height: 58px;
    flex: none;
  }
  .sleeve {
    position: relative;
    z-index: 1;
    width: 58px;
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 4px 0 12px rgb(0 0 0 / 0.3);
  }
  .record {
    position: absolute;
    top: 2px;
    left: 2px;
    transition: transform 700ms var(--ease-out);
  }
  .deck.playing .record {
    transform: translateX(32px);
  }
  .text {
    min-width: 0;
  }
  .heart {
    flex: none;
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--ink-3);
    transition:
      color var(--t-fast),
      transform var(--t-med) var(--ease-spring);
  }
  .heart:hover {
    color: var(--ink);
  }
  .heart.on {
    color: var(--accent);
    animation: beat 360ms var(--ease-spring);
  }
  @keyframes beat {
    40% {
      transform: scale(1.3);
    }
  }
  .title {
    font-weight: 600;
    font-size: 15px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .artist {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--ink-2);
    font-size: 13px;
    min-width: 0;
  }
  .artist span {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .center {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .buttons {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 18px;
  }
  .icon {
    position: relative;
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--ink-2);
    transition:
      color var(--t-fast),
      transform var(--t-fast) var(--ease-out);
  }
  .icon:hover {
    color: var(--ink);
  }
  .icon:active {
    transform: scale(0.9);
  }
  .icon.on {
    color: var(--accent);
  }
  .icon.on::after {
    content: "";
    position: absolute;
    bottom: 1px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--accent);
  }
  .one {
    position: absolute;
    top: 5px;
    right: 3px;
    font-size: 9px;
    font-weight: 800;
  }
  .play {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--on-accent);
    transition:
      transform var(--t-fast) var(--ease-spring),
      box-shadow var(--t-med);
  }
  .play:hover {
    transform: scale(1.07);
    box-shadow: 0 0 0 6px rgb(var(--accent-rgb) / 0.18);
  }
  .play:active {
    transform: scale(0.94);
  }
  .play .glyph {
    display: grid;
    animation: pop 260ms var(--ease-spring);
  }
  @keyframes pop {
    from {
      transform: scale(0.6) rotate(-20deg);
      opacity: 0.4;
    }
  }
  .play.loading {
    animation: breathe 1.2s ease-in-out infinite;
  }
  @keyframes breathe {
    50% {
      box-shadow: 0 0 0 8px rgb(var(--accent-rgb) / 0.22);
    }
  }
  .seek {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .seek :global(.slider) {
    flex: 1;
  }
  .tm {
    width: 44px;
    font-size: 12px;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .right {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 6px;
  }
  .vol {
    width: 110px;
  }
</style>
