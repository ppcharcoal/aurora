<script lang="ts">
  // The transition editor (desktop): song A's ending on top, song B's start
  // below, on one time line. Drag B to choose where it comes in, drag the
  // yellow volume points to shape the fades, then preview and save.
  // Only Aurora's own transition settings change; the music files are never edited.
  import { invoke } from "@tauri-apps/api/core";
  import { onDestroy, onMount, untrack } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { mediaSrc } from "../media";
  import { output } from "../output.svelte";
  import { player } from "../player.svelte";
  import { settings } from "../settings.svelte";
  import { clampMix, gainA, gainB, transitions, type Mix, type PairMode } from "../transitions.svelte";
  import type { Track } from "../types";
  import { ui } from "../ui.svelte";
  import Icon from "./Icon.svelte";

  let props: { a: Track; b: Track } = $props();
  // The dialog is opened anew for each pair (keyed in App.svelte): plain copies are fine.
  const { a, b } = untrack(() => ({ a: props.a, b: props.b }));

  const existing = transitions.pair(a, b);
  /** "default" = follow the setting in Settings → Playback. */
  let mode = $state<PairMode | "default">(existing?.mode ?? "default");
  let draft = $state<Mix>(existing?.mix ? clampMix(existing.mix, a.durationMs, b.durationMs) : transitions.smoothMix(a, b));
  let smooth = $state<Mix>(transitions.smoothMix(a, b));

  const effective = $derived<PairMode>(mode === "default" ? transitions.value.mode : mode);
  /** What the canvas shows: the custom draft, the Smooth plan, or B straight after A. */
  const shown = $derived<Mix>(
    effective === "custom"
      ? draft
      : effective === "smooth"
        ? smooth
        : { bStart: a.durationMs, aEnd: a.durationMs, bOffset: 0, fadeOut: 0, fadeIn: 0, aGain: 1, bGain: 1, curve: "linear" },
  );

  // ------------------------------------------------------- waveforms --
  const WIN = 45000;
  const aWin = Math.max(0, a.durationMs - WIN);
  const bWin = Math.min(b.durationMs, WIN);
  const POINTS = 900;
  let peaksA = $state<number[] | null>(null);
  let peaksB = $state<number[] | null>(null);
  let waveError = $state("");

  onMount(async () => {
    // Start from the analysed Smooth plan (silence trimmed).
    const [ba, bb] = await Promise.all([transitions.boundsOf(a), transitions.boundsOf(b)]);
    smooth = transitions.smoothMix(a, b, ba, bb);
    if (!existing?.mix) draft = { ...smooth };
    center = defaultCenter();
    try {
      const [pa, pb] = await Promise.all([
        invoke<number[]>("audio_peaks", { path: a.path, startMs: Math.round(aWin), durMs: Math.round(a.durationMs - aWin), points: POINTS }),
        invoke<number[]>("audio_peaks", { path: b.path, startMs: 0, durMs: Math.round(bWin), points: POINTS }),
      ]);
      peaksA = pa;
      peaksB = pb;
    } catch (e) {
      waveError = String(e);
    }
  });

  // ------------------------------------------------------------ view --
  const spans = [10000, 20000, 40000];
  let span = $state(20000);
  const defaultCenter = () => (shown.bStart + Math.max(shown.aEnd, shown.bStart + shown.fadeIn)) / 2;
  let center = $state(0);
  center = defaultCenter();
  const v0 = $derived(center - span / 2);
  let W = $state(800);
  const LANE = 96;
  const x = (t: number) => ((t - v0) / span) * W;
  const tAt = (px: number) => v0 + (px / W) * span;

  function wavePath(peaks: number[], startT: number, stepT: number, top: number) {
    const mid = top + LANE / 2;
    let d = "";
    for (let i = 0; i < peaks.length; i++) {
      const px = x(startT + i * stepT);
      if (px < -2 || px > W + 2) continue;
      const h = Math.max(1, (peaks[i] / 255) * (LANE / 2 - 6));
      d += `M${px.toFixed(1)} ${(mid - h).toFixed(1)}V${(mid + h).toFixed(1)}`;
    }
    return d;
  }
  const pathA = $derived(peaksA ? wavePath(peaksA, aWin, (a.durationMs - aWin) / POINTS, 0) : "");
  const pathB = $derived(peaksB ? wavePath(peaksB, shown.bStart - shown.bOffset, bWin / POINTS, LANE + 18) : "");

  function envelope(fn: (m: Mix, t: number) => number, top: number) {
    const pts: string[] = [];
    for (let i = 0; i <= 160; i++) {
      const t = v0 + (i / 160) * span;
      pts.push(`${x(t).toFixed(1)},${(top + 8 + (1 - fn(shown, t)) * (LANE - 16)).toFixed(1)}`);
    }
    return pts.join(" ");
  }
  const envA = $derived(envelope(gainA, 0));
  const envB = $derived(envelope(gainB, LANE + 18));
  const yOf = (g: number, top: number) => top + 8 + (1 - g) * (LANE - 16);

  const sec = (ms: number) => (ms / 1000).toFixed(1);
  const ticks = $derived.by(() => {
    const step = span <= 10000 ? 1000 : span <= 20000 ? 2000 : 5000;
    const out: { px: number; label: string }[] = [];
    for (let t = Math.ceil(v0 / step) * step; t <= v0 + span; t += step) {
      const left = (a.durationMs - t) / 1000;
      if (x(t) < 16 || x(t) > W - 16) continue; // labels at the very edge would be cut off
      out.push({ px: x(t), label: left > 0.05 ? `−${left.toFixed(0)}s` : left < -0.05 ? `+${(-left).toFixed(0)}s` : "end" });
    }
    return out;
  });

  // ------------------------------------------------------------ drag --
  type Grab = "b" | "aEnd" | "fadeOut" | "fadeIn" | "pan";
  let grab: { what: Grab; x0: number; y0: number; m: Mix; c: number } | null = null;

  function down(what: Grab, e: PointerEvent) {
    e.stopPropagation();
    if (what !== "pan") makeCustom();
    grab = { what, x0: e.clientX, y0: e.clientY, m: { ...draft }, c: center };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }

  function move(e: PointerEvent) {
    if (!grab) return;
    const dt = ((e.clientX - grab.x0) / W) * span;
    const dg = -(e.clientY - grab.y0) / (LANE - 16);
    const m = { ...grab.m };
    switch (grab.what) {
      case "pan":
        center = grab.c - dt;
        return;
      case "b":
        m.bStart = grab.m.bStart + dt;
        break;
      case "aEnd":
        m.aEnd = Math.max(grab.m.aEnd + dt, m.bStart);
        break;
      case "fadeOut":
        m.fadeOut = grab.m.fadeOut - dt;
        m.aGain = grab.m.aGain + dg;
        break;
      case "fadeIn":
        m.fadeIn = grab.m.fadeIn + dt;
        m.bGain = grab.m.bGain + dg;
        break;
    }
    draft = clampMix(m, a.durationMs, b.durationMs);
  }

  function up() {
    grab = null;
  }

  function wheel(e: WheelEvent) {
    e.preventDefault();
    center += ((e.deltaX || e.deltaY) / W) * span;
  }

  /** Editing anything makes this pair's transition a custom one (starting from what's shown). */
  function makeCustom() {
    if (mode !== "custom") {
      draft = { ...shown, bStart: Math.min(shown.bStart, a.durationMs - 1000) };
      draft = clampMix(draft, a.durationMs, b.durationMs);
      mode = "custom";
    }
  }

  function setNum(k: keyof Mix, v: number) {
    makeCustom();
    const m = { ...draft, [k]: v };
    if (k === "bStart") m.bStart = draft.aEnd - v; // the field is "overlap"
    if (k === "aEnd") {
      const overlap = draft.aEnd - draft.bStart;
      m.aEnd = a.durationMs - v; // the field is "cut from A's end"
      m.bStart = m.aEnd - overlap;
    }
    draft = clampMix(m, a.durationMs, b.durationMs);
  }

  // --------------------------------------------------------- preview --
  let playing = $state(false);
  let playhead = $state<number | null>(null);
  let pa: HTMLAudioElement | null = null;
  let pb: HTMLAudioElement | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  function stopPreview() {
    clearInterval(timer);
    pa?.pause();
    pb?.pause();
    pa = pb = null;
    playing = false;
    playhead = null;
  }

  /**
   * Plays exactly what the timeline shows, from its left edge to its right
   * edge, with the current settings (also unsaved ones). A follows its own
   * clock until it stops, then B's clock takes over.
   */
  async function preview() {
    if (playing) return stopPreview();
    if (player.playing) await player.toggle();
    const m = $state.snapshot(shown) as Mix;
    const vol = settings.value.volume ** 2;
    const from = Math.max(0, v0);
    const until = v0 + span; // the right edge of the view
    const A = new Audio(mediaSrc(a.path));
    const B = new Audio(mediaSrc(b.path));
    pa = A;
    pb = B;
    for (const el of [A, B]) output.attach(el);
    playing = true;
    playhead = from;
    let aOn = from < m.aEnd;
    let bOn = false;
    const startB = (t: number) => {
      bOn = true;
      B.currentTime = (m.bOffset + Math.max(0, t - m.bStart)) / 1000;
      B.volume = Math.min(1, vol * gainB(m, t));
      B.play().catch(() => {});
    };
    if (aOn) {
      A.currentTime = from / 1000;
      A.volume = Math.min(1, vol * gainA(m, from));
      await A.play().catch(() => {});
    }
    if (from >= m.bStart) startB(from);
    // Nothing of A in view and B not due yet: keep time with the system clock until B starts.
    const t0 = performance.now();
    timer = setInterval(() => {
      if (pa !== A) return;
      const aT = A.currentTime * 1000;
      let t: number;
      if (aOn && !A.paused) t = aT;
      else if (bOn) t = m.bStart + (B.currentTime * 1000 - m.bOffset);
      else t = from + (performance.now() - t0);
      if (aOn && (aT >= m.aEnd || A.ended)) {
        aOn = false;
        A.pause();
      }
      if (!bOn && t >= m.bStart) startB(t);
      if (aOn) A.volume = Math.min(1, vol * gainA(m, aT));
      if (bOn) B.volume = Math.min(1, vol * gainB(m, t));
      playhead = t;
      if (t >= until || (!aOn && bOn && B.ended)) stopPreview();
    }, 30);
  }

  /** Where the main player is in these two songs (shown as a faint line). */
  const nowAt = $derived.by(() => {
    const c = player.current;
    if (!c || playing) return null;
    if (c.key === a.key) return player.position;
    if (c.key === b.key) return shown.bStart + (player.position - shown.bOffset);
    return null;
  });

  onDestroy(stopPreview);

  // ------------------------------------------------------------ save --
  function save() {
    stopPreview();
    if (mode === "default") transitions.setPair(a, b, null);
    else if (mode === "custom") transitions.setPair(a, b, { mode, mix: $state.snapshot(draft) as Mix });
    else transitions.setPair(a, b, { mode });
    ui.toast("Transition saved", "success", 1800);
    close();
  }

  function close() {
    stopPreview();
    ui.transitionEdit = null;
  }

  const modes: { v: PairMode | "default"; label: string; hint: string }[] = [
    { v: "default", label: "Default", hint: `As in Settings (${transitions.value.mode === "smooth" ? "Smooth" : "None"})` },
    { v: "none", label: "None", hint: "One after the other" },
    { v: "smooth", label: "Smooth", hint: "Trim silence, crossfade" },
    { v: "custom", label: "Custom", hint: "Your own mix below" },
  ];
</script>

<svelte:window onpointermove={move} onpointerup={up} onkeydown={(e) => e.key === "Escape" && close()} />

<div class="back" transition:fade={{ duration: 150 }} role="presentation" onpointerdown={close}></div>
<div class="dlg" role="dialog" aria-label="Transition" transition:scale={{ start: 0.96, duration: 180 }}>
  <header>
    <h2>Transition</h2>
    <p class="pair"><b>{a.title}</b> <span class="muted">{a.artist}</span> <Icon name="next" size={13} /> <b>{b.title}</b> <span class="muted">{b.artist}</span></p>
  </header>

  <div class="modes" role="radiogroup" aria-label="Transition type">
    {#each modes as m (m.v)}
      <button role="radio" aria-checked={mode === m.v} class:on={mode === m.v} onclick={() => (m.v === "custom" ? makeCustom() : (mode = m.v))}>
        {m.label}<small>{m.hint}</small>
      </button>
    {/each}
  </div>

  <div class="stage" bind:clientWidth={W}>
    <svg width={W} height={LANE * 2 + 40} role="application" aria-label="Transition timeline" onpointerdown={(e) => down("pan", e)} onwheel={wheel}>
      <!-- lanes -->
      <rect class="lane" x="0" y="0" width={W} height={LANE} rx="12" />
      <rect class="lane" x="0" y={LANE + 18} width={W} height={LANE} rx="12" />
      <!-- A: waveform, the part after it stops greyed out -->
      <clipPath id="clipA"><rect x="0" y="0" width={Math.max(0, Math.min(W, x(shown.aEnd)))} height={LANE} /></clipPath>
      <path class="wave dim" d={pathA} />
      <path class="wave a" d={pathA} clip-path="url(#clipA)" />
      <!-- B: waveform, the skipped intro greyed out -->
      <clipPath id="clipB"><rect x={Math.max(0, x(shown.bStart))} y={LANE + 18} width={W} height={LANE} /></clipPath>
      <g class="bbody" role="button" tabindex="-1" aria-label="Song B: drag to move where it starts" onpointerdown={(e) => down("b", e)}>
        <rect x={Math.max(0, x(shown.bStart - shown.bOffset))} y={LANE + 18} width={W} height={LANE} fill="transparent" />
        <path class="wave dim" d={pathB} />
        <path class="wave b" d={pathB} clip-path="url(#clipB)" />
      </g>
      {#if !peaksA && !waveError}
        <text x={W / 2} y={LANE + 9} class="loading" text-anchor="middle">Reading the songs…</text>
      {/if}
      <!-- markers -->
      <line class="mark" x1={x(shown.bStart)} x2={x(shown.bStart)} y1="0" y2={LANE * 2 + 18} />
      <line class="mark end" x1={x(a.durationMs)} x2={x(a.durationMs)} y1="0" y2={LANE} />
      <!-- volume lines -->
      <polyline class="env" points={envA} />
      <polyline class="env" points={envB} />
      <!-- handles -->
      <g class="handles">
        <circle role="slider" tabindex="0" aria-label="Fade out start and song A volume" aria-valuenow={Math.round(shown.fadeOut)} cx={x(shown.aEnd - shown.fadeOut)} cy={yOf(shown.aGain, 0)} r="7" onpointerdown={(e) => down("fadeOut", e)} />
        <rect role="slider" tabindex="0" aria-label="Where song A stops" aria-valuenow={Math.round(shown.aEnd)} x={x(shown.aEnd) - 5} y={LANE - 22} width="10" height="18" rx="3" onpointerdown={(e) => down("aEnd", e)} />
        <circle role="slider" tabindex="0" aria-label="Fade in end and song B volume" aria-valuenow={Math.round(shown.fadeIn)} cx={x(shown.bStart + shown.fadeIn)} cy={yOf(shown.bGain, LANE + 18)} r="7" onpointerdown={(e) => down("fadeIn", e)} />
      </g>
      {#if nowAt !== null && nowAt >= v0 && nowAt <= v0 + span}
        <line class="now" x1={x(nowAt)} x2={x(nowAt)} y1="0" y2={LANE * 2 + 18} />
      {/if}
      {#if playhead !== null}
        <line class="head" x1={x(playhead)} x2={x(playhead)} y1="-2" y2={LANE * 2 + 20} />
        <circle class="headknob" cx={x(playhead)} cy={LANE + 9} r="5" />
      {/if}
      <!-- time axis: time left in song A -->
      {#each ticks as tk (tk.px)}
        <text class="tick" x={tk.px} y={LANE * 2 + 34} text-anchor="middle">{tk.label}</text>
      {/each}
      <text class="lanelabel" x="10" y="18">A · {a.title}</text>
      <text class="lanelabel" x="10" y={LANE + 36}>B · {b.title}</text>
    </svg>
  </div>

  <div class="bar">
    <button class="btn play" onclick={preview} aria-label={playing ? "Stop preview" : "Preview the transition"}>
      <Icon name={playing ? "pause" : "play"} size={15} />
      {playing ? "Stop" : "Preview what's shown"}
    </button>
    <div class="zoom" role="radiogroup" aria-label="Zoom">
      {#each spans as s (s)}
        <button role="radio" aria-checked={span === s} class:on={span === s} onclick={() => (span = s)}>{s / 1000} s</button>
      {/each}
      <button onclick={() => (center = defaultCenter())} title="Centre on the transition"><Icon name="restore" size={13} /></button>
    </div>
  </div>
  {#if waveError}<p class="warn">Waveforms aren't available ({waveError}). You can still set the transition with the controls below.</p>{/if}

  <div class="controls" class:off={effective !== "custom"}>
    <label>
      <span>Overlap <b>{sec(draft.aEnd - draft.bStart)} s</b></span>
      <input type="range" min="0" max={Math.min(30000, a.durationMs - 1000)} step="100" value={draft.aEnd - draft.bStart} oninput={(e) => setNum("bStart", +e.currentTarget.value)} />
    </label>
    <label>
      <span>Cut from A's end <b>{sec(a.durationMs - draft.aEnd)} s</b></span>
      <input type="range" min="0" max={Math.min(30000, a.durationMs / 2)} step="100" value={a.durationMs - draft.aEnd} oninput={(e) => setNum("aEnd", +e.currentTarget.value)} />
    </label>
    <label>
      <span>Skip B's intro <b>{sec(draft.bOffset)} s</b></span>
      <input type="range" min="0" max={Math.min(30000, b.durationMs / 2)} step="100" value={draft.bOffset} oninput={(e) => setNum("bOffset", +e.currentTarget.value)} />
    </label>
    <label>
      <span>Fade out A <b>{sec(draft.fadeOut)} s</b></span>
      <input type="range" min="0" max="20000" step="100" value={draft.fadeOut} oninput={(e) => setNum("fadeOut", +e.currentTarget.value)} />
    </label>
    <label>
      <span>Fade in B <b>{sec(draft.fadeIn)} s</b></span>
      <input type="range" min="0" max="20000" step="100" value={draft.fadeIn} oninput={(e) => setNum("fadeIn", +e.currentTarget.value)} />
    </label>
    <label>
      <span>Fade shape</span>
      <span class="curve">
        <button class:on={draft.curve === "smooth"} onclick={() => { makeCustom(); draft = { ...draft, curve: "smooth" }; }}>Smooth</button>
        <button class:on={draft.curve === "linear"} onclick={() => { makeCustom(); draft = { ...draft, curve: "linear" }; }}>Linear</button>
      </span>
    </label>
    <label>
      <span>A volume <b>{Math.round(draft.aGain * 100)}%</b></span>
      <input type="range" min="0" max="1" step="0.01" value={draft.aGain} oninput={(e) => setNum("aGain", +e.currentTarget.value)} />
    </label>
    <label>
      <span>B volume <b>{Math.round(draft.bGain * 100)}%</b></span>
      <input type="range" min="0" max="1" step="0.01" value={draft.bGain} oninput={(e) => setNum("bGain", +e.currentTarget.value)} />
    </label>
  </div>

  <p class="note">
    Drag song B to choose where it comes in, the yellow points to shape the fades and volumes, and the small bar on song A to choose where it stops.
    Drag the background (or scroll) to move the view: Preview plays exactly the part that's shown, from its left edge to its right edge.
    This only changes how Aurora plays these two songs one after the other: your music files stay exactly as they are.
  </p>

  <div class="row">
    {#if mode === "custom"}<button class="btn" onclick={() => (draft = { ...smooth })}>Reset to Smooth</button>{/if}
    <span class="grow"></span>
    <button class="btn" onclick={close}>Cancel</button>
    <button class="btn primary" onclick={save}>Save</button>
  </div>
</div>

<style>
  .back {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgb(10 8 14 / 0.6);
  }
  .dlg {
    position: fixed;
    z-index: 61;
    left: 50%;
    top: 50%;
    translate: -50% -50%;
    width: min(900px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
    padding: 22px 24px;
    border-radius: var(--r-panel);
    background: var(--night-2);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
  }
  h2 {
    font-size: 22px;
  }
  .pair {
    margin: 6px 0 14px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    font-size: 14px;
  }
  .modes {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 14px;
  }
  .modes button,
  .curve button,
  .zoom button {
    padding: 8px 10px;
    border-radius: 10px;
    background: var(--well);
    border: 1px solid var(--line);
    text-align: left;
  }
  .modes button {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .modes small {
    color: var(--ink-3);
    font-size: 12px;
  }
  .modes .on,
  .curve .on,
  .zoom .on {
    border-color: var(--accent);
    background: rgb(var(--accent-rgb) / 0.12);
  }
  .stage {
    width: 100%;
    user-select: none;
    touch-action: none;
  }
  svg {
    display: block;
    cursor: grab;
  }
  .lane {
    fill: rgb(var(--ink-rgb) / 0.05);
    stroke: var(--line);
  }
  .wave {
    stroke-width: 1.4;
    stroke-linecap: round;
  }
  .wave.a {
    stroke: rgb(var(--ink-rgb) / 0.85);
  }
  .wave.b {
    stroke: var(--accent);
  }
  .wave.dim {
    stroke: rgb(var(--ink-rgb) / 0.18);
  }
  .bbody {
    cursor: ew-resize;
  }
  .mark {
    stroke: rgb(var(--ink-rgb) / 0.35);
    stroke-dasharray: 3 4;
  }
  .mark.end {
    stroke: rgb(var(--ink-rgb) / 0.2);
  }
  .env {
    fill: none;
    stroke: #f2c94c;
    stroke-width: 2;
    pointer-events: none;
  }
  .handles circle,
  .handles rect {
    fill: #f2c94c;
    stroke: var(--night-2);
    stroke-width: 2;
    cursor: move;
  }
  .handles rect {
    cursor: ew-resize;
  }
  .head {
    stroke: #fff;
    stroke-width: 2;
    pointer-events: none;
    filter: drop-shadow(0 0 3px rgb(0 0 0 / 0.6));
  }
  .headknob {
    fill: #fff;
    pointer-events: none;
  }
  .now {
    stroke: rgb(var(--ink-rgb) / 0.55);
    stroke-width: 1.5;
    stroke-dasharray: 2 3;
    pointer-events: none;
  }
  .tick,
  .loading {
    fill: var(--ink-3);
    font-size: 11px;
  }
  .lanelabel {
    fill: var(--ink-2);
    font-size: 12px;
    font-weight: 600;
    pointer-events: none;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 12px 0;
  }
  .zoom {
    display: flex;
    gap: 6px;
    margin-left: auto;
  }
  .zoom button {
    padding: 5px 10px;
    font-size: 13px;
  }
  .controls {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 12px 18px;
    margin-top: 6px;
  }
  .controls.off {
    opacity: 0.55;
  }
  .controls label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: var(--ink-2);
  }
  .controls b {
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .controls input {
    accent-color: var(--accent);
  }
  .curve {
    display: flex;
    gap: 6px;
  }
  .curve button {
    padding: 4px 10px;
    font-size: 13px;
  }
  .note,
  .warn {
    font-size: 12.5px;
    color: var(--ink-3);
    margin: 14px 0 0;
  }
  .warn {
    color: rgb(240 140 120);
  }
  .row {
    display: flex;
    gap: 10px;
    margin-top: 18px;
  }
  .grow {
    flex: 1;
  }
  @media (max-width: 720px) {
    .modes {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
