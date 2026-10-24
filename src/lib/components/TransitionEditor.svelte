<script lang="ts">
  // The transition editor (desktop). Both whole songs on one timeline: song A
  // on top, song B below, placed where it comes in. Like a small audio editor:
  //  - click or drag on the time ruler (or click a waveform) to place the playhead, Space plays from there;
  //  - drag song B sideways to choose where it comes in, the bar on A to choose where A stops;
  //  - the yellow lines are the volumes: double-click a line to add a point, drag points,
  //    double-click / right-click / Delete to remove one;
  //  - scroll to move along, Ctrl+scroll (or the zoom slider) to zoom; Ctrl+Z undoes.
  // Only Aurora's transition settings change; the music files are never edited.
  import { onDestroy, onMount, untrack } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { mediaSrc } from "../media";
  import { output } from "../output.svelte";
  import { player } from "../player.svelte";
  import { settings } from "../settings.svelte";
  import { graph } from "../audiograph";
  import { loudness } from "../loudness.svelte";
  import {
    clampMix,
    FX_NAMES,
    fxA,
    fxB,
    gainA,
    gainB,
    hasFx,
    mixEnd,
    transitions,
    withPoints,
    type FxName,
    type Mix,
    type PairMode,
    type Point,
  } from "../transitions.svelte";
  import type { Track } from "../types";
  import { ui } from "../ui.svelte";
  import Icon from "./Icon.svelte";

  let props: { a: Track; b: Track } = $props();
  // The dialog is opened anew for each pair (keyed in App.svelte): plain copies are fine.
  const { a, b } = untrack(() => ({ a: props.a, b: props.b }));
  const aDur = a.durationMs;
  const bDur = b.durationMs;

  const existing = transitions.pair(a, b);
  let mode = $state<PairMode | "default">(existing?.mode ?? "default");
  let draft = $state<Mix>(withPoints(clampMix(existing?.mix ?? transitions.smoothMix(a, b), aDur, bDur)));
  let smooth = $state<Mix>(transitions.smoothMix(a, b));
  const noneMix: Mix = { bStart: aDur, aEnd: aDur, bOffset: 0, fadeOut: 0, fadeIn: 0, aGain: 1, bGain: 1, curve: "linear" };

  const effective = $derived<PairMode>(mode === "default" ? transitions.value.mode : mode);
  const custom = $derived(effective === "custom");
  const shown = $derived<Mix>(custom ? draft : effective === "smooth" ? smooth : noneMix);

  // ------------------------------------------------------------- undo --
  let undoStack = $state<string[]>([]);
  let redoStack = $state<string[]>([]);
  /** Call once at the start of each change (a drag, a slider move…). */
  function remember() {
    undoStack = [...undoStack.slice(-80), JSON.stringify({ mode, draft })];
    redoStack = [];
  }
  function restore(from: string[], to: string[]) {
    const last = from.at(-1);
    if (!last) return [from, to];
    const now = JSON.stringify({ mode, draft });
    const s = JSON.parse(last) as { mode: typeof mode; draft: Mix };
    mode = s.mode;
    draft = s.draft;
    selected = null;
    return [from.slice(0, -1), [...to, now]];
  }
  const undo = () => ([undoStack, redoStack] = restore(undoStack, redoStack));
  const redo = () => ([redoStack, undoStack] = restore(redoStack, undoStack));

  /** Editing anything makes this pair's transition a custom one, starting from what's shown. */
  function makeCustom() {
    if (mode === "custom") return;
    const base = effective === "none" ? { ...noneMix, bStart: aDur - 200 } : shown;
    draft = withPoints(clampMix({ ...base, aPoints: undefined, bPoints: undefined, aFx: undefined, bFx: undefined }, aDur, bDur));
    mode = "custom";
  }

  function edit(fn: (m: Mix) => Mix) {
    makeCustom();
    draft = clampMix(fn(structuredClone($state.snapshot(draft)) as Mix), aDur, bDur);
  }

  // -------------------------------------------------------- waveforms --
  const count = (dur: number) => Math.round(Math.min(4000, Math.max(400, dur / 40)));
  let peaksA = $state<number[] | null>(null);
  let peaksB = $state<number[] | null>(null);
  let waveError = $state("");

  onMount(async () => {
    const [ba, bb] = await Promise.all([transitions.boundsOf(a), transitions.boundsOf(b)]);
    smooth = transitions.smoothMix(a, b, ba, bb);
    if (!existing?.mix) draft = withPoints(clampMix(smooth, aDur, bDur));
    fitTransition();
    try {
      const [pa, pb] = await Promise.all([
        transitions.peaksOf(a.path, 0, Math.round(aDur), count(aDur)),
        transitions.peaksOf(b.path, 0, Math.round(bDur), count(bDur)),
      ]);
      peaksA = pa;
      peaksB = pb;
    } catch (e) {
      waveError = String(e);
    }
  });

  // ------------------------------------------------------------ view --
  let W = $state(820);
  const RULER = 26;
  const LANE = 110;
  const GAP = 14;
  const A_TOP = RULER;
  const B_TOP = RULER + LANE + GAP;
  const OV_TOP = B_TOP + LANE + 12;
  const OV_H = 22;
  const H = OV_TOP + OV_H;

  /** B's whole song on the shared timeline. */
  const bFrom = $derived(shown.bStart - shown.bOffset);
  const extent = $derived(Math.max(aDur, bFrom + bDur));
  let v0 = $state(0);
  let span = $state(30000);
  const MIN_SPAN = 2000;

  function setView(start: number, len: number) {
    span = Math.min(Math.max(MIN_SPAN, len), extent + 4000);
    v0 = Math.min(Math.max(-2000, start), extent + 2000 - span);
  }
  function fitTransition() {
    const m = shown;
    const end = mixEnd(m);
    const len = Math.max(12000, end - m.bStart + 16000);
    setView(m.bStart - (len - (end - m.bStart)) / 2, len);
  }
  const fitAll = () => setView(-1000, extent + 2000);
  function zoomBy(f: number, at = v0 + span / 2) {
    const k = (at - v0) / span;
    const len = span * f;
    setView(at - k * Math.min(Math.max(MIN_SPAN, len), extent + 4000), len);
  }

  const x = (t: number) => ((t - v0) / span) * W;
  const tAt = (px: number) => v0 + (px / W) * span;
  const yOf = (g: number, top: number) => top + 10 + (1 - g) * (LANE - 20);
  const gAt = (py: number, top: number) => Math.min(1, Math.max(0, 1 - (py - top - 10) / (LANE - 20)));

  function wavePath(peaks: number[] | null, start: number, dur: number, top: number) {
    if (!peaks) return "";
    const n = peaks.length;
    const step = dur / n;
    const i0 = Math.max(0, Math.floor((v0 - start) / step));
    const i1 = Math.min(n, Math.ceil((v0 + span - start) / step) + 1);
    const group = Math.max(1, Math.floor((i1 - i0) / (W / 2)));
    const mid = top + LANE / 2;
    let d = "";
    for (let i = i0; i < i1; i += group) {
      let p = 0;
      for (let j = i; j < Math.min(i1, i + group); j++) p = Math.max(p, peaks[j]);
      const px = x(start + (i + group / 2) * step).toFixed(1);
      const h = Math.max(0.8, (p / 255) * (LANE / 2 - 8));
      d += `M${px} ${(mid - h).toFixed(1)}V${(mid + h).toFixed(1)}`;
    }
    return d;
  }
  const pathA = $derived(wavePath(peaksA, 0, aDur, A_TOP));
  const pathB = $derived(wavePath(peaksB, bFrom, bDur, B_TOP));

  // ----------------------------------------------- volume & effect lines --
  type Param = "vol" | FxName;
  const PARAMS: { v: Param; label: string; color: string; hint: string }[] = [
    { v: "vol", label: "Volume", color: "#f2c94c", hint: "How loud each song is" },
    { v: "damp", label: "Dampen", color: "#6fb6ff", hint: "Muffles the sound, like through a wall (low-pass filter)" },
    { v: "bass", label: "Bass", color: "#ff8a5c", hint: "Low end, up to ±12 dB (middle = unchanged)" },
    { v: "treble", label: "Treble", color: "#c792ff", hint: "Highs, up to ±12 dB (middle = unchanged)" },
  ];
  let param = $state<Param>("vol");
  const paramInfo = $derived(PARAMS.find((p) => p.v === param)!);

  /** The points of one line on one song (undefined: the line isn't drawn yet). */
  function listOf(m: Mix, lane: "a" | "b", p: Param = param): Point[] | undefined {
    if (p === "vol") return lane === "a" ? m.aPoints : m.bPoints;
    return (lane === "a" ? m.aFx : m.bFx)?.[p];
  }
  function setList(m: Mix, lane: "a" | "b", pts: Point[] | undefined, p: Param = param) {
    if (p === "vol") {
      if (lane === "a") m.aPoints = pts;
      else m.bPoints = pts;
      return;
    }
    const fx = { ...((lane === "a" ? m.aFx : m.bFx) ?? {}) };
    if (pts?.length) fx[p] = pts;
    else delete fx[p];
    if (lane === "a") m.aFx = fx;
    else m.bFx = fx;
  }
  /** A line's value (0–1, as drawn) at A-time t. */
  function valueAt(m: Mix, lane: "a" | "b", t: number, p: Param = param) {
    if (p === "vol") return lane === "a" ? gainA(m, t) : gainB(m, t);
    const fx = lane === "a" ? fxA(m, t) : fxB(m, t);
    return p === "damp" ? fx.damp : fx[p] / 2 + 0.5;
  }
  /** How a value reads for the selected line. */
  function label(g: number, p: Param = param) {
    if (p === "vol") return `${Math.round(g * 100)}%`;
    if (p === "damp") return g < 0.005 ? "off" : `${Math.round(g * 100)}%`;
    const db = (g - 0.5) * 24;
    return `${db > 0.05 ? "+" : ""}${db.toFixed(1)} dB`;
  }
  const effectsUsed = $derived(FX_NAMES.filter((n) => shown.aFx?.[n]?.length || shown.bFx?.[n]?.length));

  function envelope(fn: (m: Mix, t: number) => number, top: number, from: number, to: number) {
    const pts: string[] = [];
    const t0 = Math.max(v0, from);
    const t1 = Math.min(v0 + span, to);
    if (t1 <= t0) return "";
    const steps = Math.max(2, Math.round(((t1 - t0) / span) * (W / 3)));
    for (let i = 0; i <= steps; i++) {
      const t = t0 + ((t1 - t0) * i) / steps;
      pts.push(`${x(t).toFixed(1)},${yOf(fn(shown, t), top).toFixed(1)}`);
    }
    return pts.join(" ");
  }
  const lines = $derived(
    PARAMS.filter((p) => p.v === param || p.v === "vol" || effectsUsed.includes(p.v as FxName)).map((p) => ({
      ...p,
      a: envelope((m, t) => valueAt(m, "a", t, p.v), A_TOP, 0, shown.aEnd + 1),
      b: envelope((m, t) => valueAt(m, "b", t, p.v), B_TOP, shown.bStart, bFrom + bDur),
    })),
  );

  const fmt = (ms: number) => {
    const neg = ms < 0;
    const v = Math.abs(ms) / 1000;
    const m = Math.floor(v / 60);
    return `${neg ? "−" : ""}${m}:${(v - m * 60).toFixed(1).padStart(4, "0")}`;
  };
  const ticks = $derived.by(() => {
    const steps = [500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000];
    const step = steps.find((s) => (s / span) * W >= 70) ?? 300000;
    const out: { px: number; label: string }[] = [];
    for (let t = Math.ceil(v0 / step) * step; t <= v0 + span; t += step) {
      const px = x(t);
      if (px < 18 || px > W - 18) continue;
      out.push({ px, label: fmt(t).replace(/\.0$/, "") });
    }
    return out;
  });

  // -------------------------------------------------------- playhead --
  /** Playhead on A's timeline (ms). */
  let head = $state(0);
  untrack(() => (head = Math.max(0, shown.bStart - 5000)));
  const bTimeAt = (t: number) => t - shown.bStart + shown.bOffset;

  // ------------------------------------------------------ selection ---
  let selected = $state<{ lane: "a" | "b"; i: number } | null>(null);
  const sel = $derived.by(() => {
    if (!selected || !custom) return null;
    const p = listOf(draft, selected.lane)?.[selected.i];
    return p ? { ...selected, p } : null;
  });

  function addPoint(lane: "a" | "b", t: number, g: number) {
    remember();
    edit((m) => {
      const pts = listOf(m, lane) ?? [];
      const at = lane === "a" ? t : t - m.bStart;
      pts.push({ t: at, g });
      pts.sort((p, q) => p.t - q.t);
      setList(m, lane, pts);
      return m;
    });
    const list = listOf(draft, lane) ?? [];
    const target = lane === "a" ? t : t - draft.bStart;
    let best = 0;
    list.forEach((p, i) => {
      if (Math.abs(p.t - target) < Math.abs(list[best].t - target)) best = i;
    });
    selected = { lane, i: best };
  }

  function removePoint(lane: "a" | "b", i: number) {
    const list = listOf(draft, lane);
    if (!list || (param === "vol" && list.length <= 1)) return; // a song keeps at least one volume point
    remember();
    edit((m) => {
      const pts = listOf(m, lane)!;
      pts.splice(i, 1);
      setList(m, lane, pts.length ? pts : undefined);
      return m;
    });
    selected = null;
  }

  function setPoint(lane: "a" | "b", i: number, p: Point) {
    edit((m) => {
      const list = listOf(m, lane)!;
      const lo = i > 0 ? list[i - 1].t : lane === "a" ? 0 : 0;
      const hi = i < list.length - 1 ? list[i + 1].t : lane === "a" ? m.aEnd : bDur - m.bOffset;
      list[i] = { t: Math.min(hi, Math.max(lo, p.t)), g: Math.min(1, Math.max(0, p.g)) };
      return m;
    });
  }

  // ------------------------------------------------------- pointers ---
  type Drag =
    | { kind: "bg"; x0: number; v: number; moved: boolean; lane: "a" | "b" | null }
    | { kind: "scrub" }
    | { kind: "b"; x0: number; start: number; moved: boolean }
    | { kind: "aEnd"; x0: number; start: number }
    | { kind: "point"; lane: "a" | "b"; i: number; x0: number; y0: number; p: Point }
    | { kind: "overview" };
  let drag: Drag | null = null;
  let svgEl = $state<SVGSVGElement>();

  const local = (e: PointerEvent | MouseEvent) => {
    const r = svgEl!.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };
  const laneAt = (py: number) => (py >= A_TOP && py <= A_TOP + LANE ? "a" : py >= B_TOP && py <= B_TOP + LANE ? "b" : null);

  // Touch screens: press and hold to add a point (or remove one), since there's no double-click or right-click.
  let hold: ReturnType<typeof setTimeout> | undefined;
  const touch = (e: PointerEvent) => e.pointerType !== "mouse";
  const cancelHold = () => clearTimeout(hold);

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    const { px, py } = local(e);
    cancelHold();
    if (touch(e) && laneAt(py)) {
      hold = setTimeout(() => {
        if (drag?.kind === "bg" && !drag.moved) {
          drag = null;
          addAt(px, py);
        }
      }, 550);
    }
    svgEl!.setPointerCapture(e.pointerId);
    if (py < RULER) {
      drag = { kind: "scrub" };
      seek(tAt(px), false);
    } else if (py >= OV_TOP) {
      drag = { kind: "overview" };
      moveOverview(px);
    } else {
      drag = { kind: "bg", x0: e.clientX, v: v0, moved: false, lane: laneAt(py) };
    }
  }

  function downOn(kind: "b" | "aEnd", e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    svgEl!.setPointerCapture(e.pointerId);
    drag = kind === "b" ? { kind, x0: e.clientX, start: shown.bStart, moved: false } : { kind, x0: e.clientX, start: shown.aEnd };
  }

  function downPoint(lane: "a" | "b", i: number, e: PointerEvent) {
    e.stopPropagation();
    if (e.button !== 0) return;
    cancelHold();
    if (touch(e)) {
      const x0 = e.clientX;
      const y0 = e.clientY;
      hold = setTimeout(() => {
        const d = drag;
        if (d?.kind === "point" && Math.abs(d.x0 - x0) < 1 && Math.abs(d.y0 - y0) < 1 && !moved) {
          drag = null;
          undoStack = undoStack.slice(0, -1); // the press didn't change anything
          removePoint(lane, i);
        }
      }, 600);
    }
    moved = false;
    svgEl!.setPointerCapture(e.pointerId);
    selected = { lane, i };
    const p = listOf(draft, lane)![i];
    remember();
    drag = { kind: "point", lane, i, x0: e.clientX, y0: e.clientY, p: { ...p } };
  }

  let moved = false;

  function move(e: PointerEvent) {
    if (!drag) return;
    if ("x0" in drag && Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - ("y0" in drag ? drag.y0 : e.clientY)) > 6) {
      moved = true;
      cancelHold();
    }
    const { px } = local(e);
    const dt = "x0" in drag ? ((e.clientX - drag.x0) / W) * span : 0;
    switch (drag.kind) {
      case "scrub":
        return seek(tAt(px), false);
      case "overview":
        return moveOverview(px);
      case "bg":
        if (Math.abs(e.clientX - drag.x0) > 3) drag.moved = true;
        if (drag.moved) v0 = Math.min(Math.max(-2000, drag.v - dt), extent + 2000 - span);
        return;
      case "b":
        if (!drag.moved && Math.abs(e.clientX - drag.x0) > 3) {
          drag.moved = true;
          remember();
        }
        if (drag.moved) {
          const s = drag.start + dt;
          edit((m) => ({ ...m, bStart: s, aEnd: Math.max(m.aEnd, s) }));
        }
        return;
      case "aEnd": {
        const s = drag.start + dt;
        edit((m) => ({ ...m, aEnd: Math.max(s, m.bStart) }));
        return;
      }
      case "point": {
        const p = drag.p;
        setPoint(drag.lane, drag.i, { t: p.t + dt, g: p.g - (e.clientY - drag.y0) / (LANE - 20) });
        return;
      }
    }
  }

  function up(e: PointerEvent) {
    cancelHold();
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === "scrub" && playing) playFrom(head);
    // A click (no drag) on a waveform puts the playhead there.
    if ((d.kind === "bg" || d.kind === "b") && !d.moved) {
      selected = null;
      seek(tAt(local(e).px));
    }
  }

  function startDragEnd(e: PointerEvent) {
    remember();
    downOn("aEnd", e);
  }

  function dbl(e: MouseEvent) {
    const { px, py } = local(e);
    addAt(px, py);
  }

  function addAt(px: number, py: number) {
    const lane = laneAt(py);
    if (!lane) return;
    const top = lane === "a" ? A_TOP : B_TOP;
    const t = tAt(px);
    if (lane === "a" && t > shown.aEnd) return;
    if (lane === "b" && (t < shown.bStart || t > bFrom + bDur)) return;
    addPoint(lane, t, gAt(py, top));
  }

  function wheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomBy(e.deltaY > 0 ? 1.18 : 1 / 1.18, tAt(local(e).px));
    } else {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      v0 = Math.min(Math.max(-2000, v0 + (d / W) * span), extent + 2000 - span);
    }
  }

  function moveOverview(px: number) {
    const t = (px / W) * (extent + 2000) - 1000;
    v0 = Math.min(Math.max(-2000, t - span / 2), extent + 2000 - span);
  }
  const ov = (t: number) => ((t + 1000) / (extent + 2000)) * W;

  function key(e: KeyboardEvent) {
    if (e.key === "Escape") return close();
    const typing = (e.target as HTMLElement)?.tagName === "INPUT" && (e.target as HTMLInputElement).type !== "range";
    if (typing) return;
    if (e.key === " ") {
      e.preventDefault();
      togglePlay();
    } else if ((e.key === "Delete" || e.key === "Backspace") && sel) {
      e.preventDefault();
      removePoint(sel.lane, sel.i);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
    }
  }

  // --------------------------------------------------------- preview --
  let playing = $state(false);
  let pa: HTMLAudioElement | null = null;
  let pb: HTMLAudioElement | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  function stopAudio() {
    clearInterval(timer);
    timer = undefined;
    for (const el of [pa, pb]) {
      if (!el) continue;
      el.pause();
      graph.release(el);
    }
    pa = pb = null;
  }

  function pause() {
    stopAudio();
    playing = false;
  }

  /** Moves the playhead; while playing, the music carries on from there (after a scrub, when it's let go). */
  function seek(t: number, restart = true) {
    head = Math.min(Math.max(0, t), extent);
    if (playing && restart) playFrom(head);
    else if (playing) stopAudio();
  }

  async function togglePlay() {
    if (playing) return pause();
    if (head >= extent - 50) head = Math.max(0, shown.bStart - 5000);
    playFrom(head);
  }

  /** Plays both songs from `from` (A's timeline) with the settings on screen, until B ends or you stop. */
  async function playFrom(from: number) {
    stopAudio();
    if (player.playing) await player.toggle();
    const m = $state.snapshot(shown) as Mix;
    const vol = settings.value.volume ** 2;
    // Volume sync, as in the player: each song at its own level, the lines on top.
    const nA = loudness.gainOf(a);
    const nB = loudness.gainOf(b);
    const A = new Audio();
    const B = new Audio();
    for (const [el, t] of [[A, a], [B, b]] as const) {
      el.crossOrigin = "anonymous"; // so the effects can process it
      el.src = mediaSrc(t.path);
      output.attach(el);
    }
    pa = A;
    pb = B;
    const fxOn = hasFx(m.aFx) || hasFx(m.bFx);
    playing = true;
    let aOn = from < m.aEnd;
    let bOn = false;
    const startB = (t: number) => {
      bOn = true;
      B.currentTime = (m.bOffset + Math.max(0, t - m.bStart)) / 1000;
      graph.setVolume(B, vol * nB * gainB(m, t));
      if (fxOn) graph.setFx(B, fxB(m, t));
      B.play().catch(() => {});
    };
    if (aOn) {
      A.currentTime = from / 1000;
      graph.setVolume(A, vol * nA * gainA(m, from));
      if (fxOn) graph.setFx(A, fxA(m, from));
      A.play().catch(() => {});
    }
    if (from >= m.bStart) startB(from);
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
      if (aOn) {
        graph.setVolume(A, vol * nA * gainA(m, aT));
        if (fxOn) graph.setFx(A, fxA(m, aT));
      }
      if (bOn) {
        graph.setVolume(B, vol * nB * gainB(m, t));
        if (fxOn) graph.setFx(B, fxB(m, t));
      }
      head = t;
      // Keep the playhead in view.
      if (t > v0 + span * 0.92 || t < v0) v0 = Math.min(Math.max(-2000, t - span * 0.1), extent + 2000 - span);
      if ((bOn && B.ended) || t >= m.bStart - m.bOffset + bDur) pause();
    }, 30);
  }

  // Changing the transition while it plays: carry on from the same spot with the new settings.
  let restart: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    void JSON.stringify(shown);
    if (!untrack(() => playing)) return;
    clearTimeout(restart);
    restart = setTimeout(() => playing && playFrom(head), 200);
  });

  /** Where the main player is in these two songs (dashed line). */
  const nowAt = $derived.by(() => {
    const c = player.current;
    if (!c || playing) return null;
    if (c.key === a.key) return player.position;
    if (c.key === b.key) return shown.bStart + (player.position - shown.bOffset);
    return null;
  });

  onDestroy(() => {
    clearTimeout(restart);
    stopAudio();
  });

  // ------------------------------------------------------------ save --
  function save() {
    pause();
    if (mode === "default") transitions.setPair(a, b, null);
    else if (mode === "custom") transitions.setPair(a, b, { mode, mix: $state.snapshot(draft) as Mix });
    else transitions.setPair(a, b, { mode });
    ui.toast("Transition saved", "success", 1800);
    close();
  }

  function close() {
    pause();
    ui.transitionEdit = null;
  }

  const modes: { v: PairMode | "default"; label: string; hint: string }[] = [
    { v: "default", label: "Default", hint: `As in Settings (${transitions.value.mode === "smooth" ? "Smooth" : "None"})` },
    { v: "none", label: "None", hint: "One after the other" },
    { v: "smooth", label: "Smooth", hint: "Trim silence, crossfade" },
    { v: "custom", label: "Custom", hint: "Your own mix below" },
  ];
  function pickMode(v: PairMode | "default") {
    remember();
    if (v === "custom") makeCustom();
    else mode = v;
    selected = null;
  }

  const zoomLevel = $derived(Math.log(span / MIN_SPAN) / Math.log((extent + 4000) / MIN_SPAN));
</script>

<svelte:window onkeydown={key} />

<div class="back" transition:fade={{ duration: 150 }} role="presentation" onpointerdown={close}></div>
<div class="dlg" role="dialog" aria-label="Transition editor" transition:scale={{ start: 0.96, duration: 180 }}>
  <header>
    <div>
      <h2>Transition editor</h2>
      <p class="pair"><b>{a.title}</b> <span class="muted">{a.artist}</span> <Icon name="next" size={13} /> <b>{b.title}</b> <span class="muted">{b.artist}</span></p>
    </div>
    <button class="icon" onclick={close} aria-label="Close editor"><Icon name="x" size={16} /></button>
  </header>

  <div class="modes" role="radiogroup" aria-label="Transition type">
    {#each modes as m (m.v)}
      <button role="radio" aria-checked={mode === m.v} class:on={mode === m.v} onclick={() => pickMode(m.v)}>{m.label}<small>{m.hint}</small></button>
    {/each}
  </div>

  <!-- toolbar -->
  <div class="tools">
    <button class="btn play" onclick={togglePlay} aria-label={playing ? "Pause" : "Play from the playhead"} title="Play / pause (Space)">
      <Icon name={playing ? "pause" : "play"} size={15} />
    </button>
    <button class="icon" onclick={() => seek(Math.max(0, shown.bStart - 5000))} title="Playhead to just before song B" aria-label="Playhead to just before song B">
      <Icon name="prev" size={16} />
    </button>
    <span class="clock" aria-live="off">
      <b>A</b> {head <= aDur ? fmt(Math.min(head, shown.aEnd)) : "—"}
      <b>B</b> {head >= shown.bStart ? fmt(bTimeAt(head)) : "—"}
    </span>
    <span class="grow"></span>
    <button class="icon" onclick={undo} disabled={!undoStack.length} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" size={16} /></button>
    <button class="icon" onclick={redo} disabled={!redoStack.length} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Icon name="redo" size={16} /></button>
    <span class="sep"></span>
    <button class="icon" onclick={() => zoomBy(1.5)} title="Zoom out" aria-label="Zoom out"><Icon name="min" size={16} /></button>
    <input class="zoom" type="range" min="0" max="1" step="0.001" value={1 - zoomLevel} aria-label="Zoom"
      oninput={(e) => {
        const z = 1 - +e.currentTarget.value;
        zoomBy((MIN_SPAN * Math.pow((extent + 4000) / MIN_SPAN, z)) / span);
      }} />
    <button class="icon" onclick={() => zoomBy(1 / 1.5)} title="Zoom in" aria-label="Zoom in"><Icon name="plus" size={16} /></button>
    <button class="btn sm" onclick={fitTransition} title="Zoom to the transition">Transition</button>
    <button class="btn sm" onclick={fitAll} title="Show both whole songs">Whole songs</button>
  </div>

  <div class="params" role="radiogroup" aria-label="Line to edit">
    <span class="plabel">Edit</span>
    {#each PARAMS as p (p.v)}
      <button role="radio" aria-checked={param === p.v} class:on={param === p.v} title={p.hint}
        onclick={() => { param = p.v; selected = null; }}>
        <i style:background={p.color}></i>{p.label}
        {#if p.v !== "vol" && effectsUsed.includes(p.v as FxName)}<small>on</small>{/if}
      </button>
    {/each}
    {#if param !== "vol" && custom && (listOf(draft, "a")?.length || listOf(draft, "b")?.length)}
      <button class="btn sm clear" onclick={() => { remember(); edit((m) => { setList(m, "a", undefined); setList(m, "b", undefined); return m; }); selected = null; }}>
        <Icon name="x" size={13} /> Remove {paramInfo.label.toLowerCase()}
      </button>
    {/if}
    <span class="phint">{paramInfo.hint}</span>
  </div>

  <div class="stage" bind:clientWidth={W}>
    <svg
      bind:this={svgEl}
      width={W}
      height={H}
      role="application"
      aria-label="Transition timeline"
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={up}
      ondblclick={dbl}
      onwheel={wheel}
    >
      <defs>
        <clipPath id="tl"><rect x="0" y="0" width={W} height={H} /></clipPath>
      </defs>
      <!-- ruler -->
      <rect class="ruler" x="0" y="0" width={W} height={RULER - 4} rx="6" />
      {#each ticks as tk (tk.px)}
        <line class="tickline" x1={tk.px} x2={tk.px} y1={RULER - 10} y2={RULER - 4} />
        <text class="tick" x={tk.px} y={RULER - 12} text-anchor="middle">{tk.label}</text>
      {/each}

      <!-- lanes -->
      <rect class="lane" x="0" y={A_TOP} width={W} height={LANE} rx="12" />
      <rect class="lane" x="0" y={B_TOP} width={W} height={LANE} rx="12" />
      <g clip-path="url(#tl)">
        <!-- song A (greyed after it stops) -->
        <clipPath id="clipA"><rect x="-10" y={A_TOP} width={Math.max(0, Math.min(W + 10, x(shown.aEnd) + 10))} height={LANE} /></clipPath>
        <path class="wave dim" d={pathA} />
        <path class="wave a" d={pathA} clip-path="url(#clipA)" />
        <!-- song B (greyed before it starts playing) -->
        <clipPath id="clipB"><rect x={x(shown.bStart)} y={B_TOP} width={Math.max(0, W - x(shown.bStart) + 10)} height={LANE} /></clipPath>
        <g class="bbody" role="button" tabindex="-1" aria-label="Song B: drag sideways to choose where it comes in" onpointerdown={(e) => downOn("b", e)}>
          <rect x={x(bFrom)} y={B_TOP + 6} width={Math.max(0, x(bFrom + bDur) - x(bFrom))} height={LANE - 12} rx="8" class="bbox" />
          <path class="wave dim" d={pathB} />
          <path class="wave b" d={pathB} clip-path="url(#clipB)" />
        </g>
        {#if !peaksA && !waveError}
          <text x={W / 2} y={A_TOP + LANE / 2} class="loading" text-anchor="middle">Reading the songs…</text>
        {/if}

        <!-- where B comes in, and where A stops -->
        <line class="mark" x1={x(shown.bStart)} x2={x(shown.bStart)} y1={A_TOP} y2={B_TOP + LANE} />
        <line class="mark end" x1={x(aDur)} x2={x(aDur)} y1={A_TOP} y2={A_TOP + LANE} />

        <!-- volume and effect lines; the selected one is bright and editable -->
        {#each lines as l (l.v)}
          <polyline class="env" class:faint={l.v !== param} stroke={l.color} points={l.a} />
          <polyline class="env" class:faint={l.v !== param} stroke={l.color} points={l.b} />
        {/each}

        {#if custom}
          <g class="pts">
            {#each listOf(draft, "a") ?? [] as p, i (param + i)}
              <circle
                role="slider"
                tabindex="0"
                aria-label={`Song A ${paramInfo.label.toLowerCase()} point at ${fmt(p.t)}`}
                aria-valuenow={Math.round(p.g * 100)}
                fill={paramInfo.color}
                class:on={sel?.lane === "a" && sel.i === i}
                cx={x(p.t)}
                cy={yOf(p.g, A_TOP)}
                r={sel?.lane === "a" && sel.i === i ? 7.5 : 6}
                onpointerdown={(e) => downPoint("a", i, e)}
                ondblclick={(e) => (e.stopPropagation(), removePoint("a", i))}
                oncontextmenu={(e) => (e.preventDefault(), removePoint("a", i))}
              />
            {/each}
            {#each listOf(draft, "b") ?? [] as p, i (param + i)}
              <circle
                role="slider"
                tabindex="0"
                aria-label={`Song B ${paramInfo.label.toLowerCase()} point at ${fmt(p.t + draft.bOffset)}`}
                aria-valuenow={Math.round(p.g * 100)}
                fill={paramInfo.color}
                class:on={sel?.lane === "b" && sel.i === i}
                cx={x(draft.bStart + p.t)}
                cy={yOf(p.g, B_TOP)}
                r={sel?.lane === "b" && sel.i === i ? 7.5 : 6}
                onpointerdown={(e) => downPoint("b", i, e)}
                ondblclick={(e) => (e.stopPropagation(), removePoint("b", i))}
                oncontextmenu={(e) => (e.preventDefault(), removePoint("b", i))}
              />
            {/each}
          </g>
        {/if}
        <rect
          class="endbar"
          role="slider"
          tabindex="0"
          aria-label="Where song A stops"
          aria-valuenow={Math.round(shown.aEnd)}
          x={x(shown.aEnd) - 5}
          y={A_TOP + LANE - 26}
          width="10"
          height="20"
          rx="3"
          onpointerdown={startDragEnd}
        />

        {#if nowAt !== null}
          <line class="now" x1={x(nowAt)} x2={x(nowAt)} y1={A_TOP} y2={B_TOP + LANE} />
        {/if}
        <!-- playhead -->
        <line class="head" x1={x(head)} x2={x(head)} y1="0" y2={B_TOP + LANE} />
        <path class="headknob" d={`M${x(head) - 6} 0h12v8l-6 6l-6-6z`} />
      </g>
      <text class="lanelabel" x="12" y={A_TOP + 18}>A · {a.title}</text>
      <text class="lanelabel" x="12" y={B_TOP + 18}>B · {b.title}</text>

      <!-- overview of both whole songs; the box is what's shown above -->
      <rect class="ov" x="0" y={OV_TOP} width={W} height={OV_H} rx="6" />
      <rect class="ova" x={ov(0)} y={OV_TOP + 4} width={Math.max(1, ov(aDur) - ov(0))} height="6" rx="2" />
      <rect class="ovb" x={ov(bFrom)} y={OV_TOP + 12} width={Math.max(1, ov(bFrom + bDur) - ov(bFrom))} height="6" rx="2" />
      <rect class="ovview" x={Math.max(0, ov(v0))} y={OV_TOP + 1} width={Math.max(4, Math.min(W, ov(v0 + span)) - Math.max(0, ov(v0)))} height={OV_H - 2} rx="5" />
      <line class="ovhead" x1={ov(head)} x2={ov(head)} y1={OV_TOP} y2={OV_TOP + OV_H} />
    </svg>
  </div>
  {#if waveError}<p class="warn">Waveforms aren't available ({waveError}). You can still set the transition with the controls below.</p>{/if}

  <div class="below">
    <div class="controls" class:off={!custom}>
      <label>
        <span>Song B comes in <b>{fmt(draft.aEnd - draft.bStart)}</b> before A stops</span>
        <input type="range" min="0" max={Math.min(aDur - 1000, 120000)} step="100" value={draft.aEnd - draft.bStart}
          onpointerdown={remember} onkeydown={remember}
          oninput={(e) => { const v = +e.currentTarget.value; edit((m) => ({ ...m, bStart: m.aEnd - v })); }} />
      </label>
      <label>
        <span>Cut from A's end <b>{fmt(aDur - draft.aEnd)}</b></span>
        <input type="range" min="0" max={Math.min(120000, aDur / 2)} step="100" value={aDur - draft.aEnd}
          onpointerdown={remember} onkeydown={remember}
          oninput={(e) => {
            const v = +e.currentTarget.value;
            edit((m) => {
              const overlap = m.aEnd - m.bStart;
              return { ...m, aEnd: aDur - v, bStart: aDur - v - overlap };
            });
          }} />
      </label>
      <label>
        <span>Skip B's intro <b>{fmt(draft.bOffset)}</b></span>
        <input type="range" min="0" max={Math.min(120000, bDur / 2)} step="100" value={draft.bOffset}
          onpointerdown={remember} onkeydown={remember}
          oninput={(e) => { const v = +e.currentTarget.value; edit((m) => ({ ...m, bOffset: v })); }} />
      </label>
      <label>
        <span>Curve between points</span>
        <span class="curve">
          <button class:on={draft.curve === "smooth"} onclick={() => (remember(), edit((m) => ({ ...m, curve: "smooth" })))}>Smooth</button>
          <button class:on={draft.curve === "linear"} onclick={() => (remember(), edit((m) => ({ ...m, curve: "linear" })))}>Linear</button>
        </span>
      </label>
    </div>

    <div class="inspector">
      {#if sel}
        <span class="ptitle">Point on song {sel.lane.toUpperCase()} at {fmt(sel.lane === "a" ? sel.p.t : sel.p.t + draft.bOffset)}</span>
        <label class="pvol">
          {paramInfo.label} <b>{label(sel.p.g)}</b>
          <input type="range" min="0" max="1" step="0.01" value={sel.p.g}
            onpointerdown={remember} onkeydown={remember}
            oninput={(e) => setPoint(sel.lane, sel.i, { t: sel.p.t, g: +e.currentTarget.value })} />
        </label>
        <button class="btn sm" onclick={() => removePoint(sel.lane, sel.i)}><Icon name="trash" size={14} /> Remove point</button>
      {:else}
        <span class="hint">
          <b>Double-click</b> (on a phone: press and hold) the {paramInfo.label.toLowerCase()} line to add a point · drag points to change time and volume · <b>right-click</b> (or press and hold) a point to remove it ·
          click the ruler or a song to move the playhead · <b>Space</b> plays from there · scroll to move, <b>Ctrl+scroll</b> to zoom
        </span>
      {/if}
    </div>
  </div>

  <div class="row">
    {#if mode === "custom"}<button class="btn" onclick={() => (remember(), (draft = withPoints(clampMix(smooth, aDur, bDur))))}>Reset to Smooth</button>{/if}
    <span class="grow"></span>
    <span class="safe">Your music files are never changed.</span>
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
    width: min(1100px, calc(100vw - 24px));
    max-height: calc(100vh - 24px);
    overflow: hidden auto;
    padding: 18px 22px;
    border-radius: var(--r-panel);
    background: var(--night-2);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  h2 {
    font-size: 21px;
  }
  .pair {
    margin: 4px 0 12px;
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
    margin-bottom: 12px;
  }
  .modes button,
  .curve button {
    padding: 7px 10px;
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
  .curve .on {
    border-color: var(--accent);
    background: rgb(var(--accent-rgb) / 0.12);
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .btn.play {
    width: 40px;
    height: 36px;
    padding: 0;
    justify-content: center;
  }
  .btn.sm {
    height: 30px;
    padding: 0 10px;
    font-size: 13px;
  }
  .icon:disabled {
    opacity: 0.35;
  }
  .clock {
    font-variant-numeric: tabular-nums;
    font-size: 13px;
    color: var(--ink-2);
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .clock b {
    color: var(--ink-3);
    font-size: 11px;
    margin-left: 6px;
  }
  .grow {
    flex: 1;
  }
  .sep {
    width: 1px;
    height: 20px;
    background: var(--line);
  }
  .zoom {
    width: 120px;
    accent-color: var(--accent);
  }
  .stage {
    width: 100%;
    user-select: none;
    touch-action: none;
  }
  svg {
    display: block;
    cursor: default;
  }
  .ruler {
    fill: rgb(var(--ink-rgb) / 0.05);
    cursor: text;
  }
  .tick {
    fill: var(--ink-3);
    font-size: 10.5px;
  }
  .tickline {
    stroke: rgb(var(--ink-rgb) / 0.25);
  }
  .lane {
    fill: rgb(var(--ink-rgb) / 0.045);
    stroke: var(--line);
  }
  .wave {
    stroke-width: 1.3;
    stroke-linecap: round;
    pointer-events: none;
  }
  .wave.a {
    stroke: rgb(var(--ink-rgb) / 0.85);
  }
  .wave.b {
    stroke: var(--accent);
  }
  .wave.dim {
    stroke: rgb(var(--ink-rgb) / 0.16);
  }
  .bbody {
    cursor: grab;
  }
  .bbox {
    fill: rgb(var(--accent-rgb) / 0.06);
    stroke: rgb(var(--accent-rgb) / 0.35);
    stroke-dasharray: 4 4;
  }
  .mark {
    stroke: rgb(var(--ink-rgb) / 0.35);
    stroke-dasharray: 3 4;
    pointer-events: none;
  }
  .mark.end {
    stroke: rgb(var(--ink-rgb) / 0.18);
  }
  .env {
    fill: none;
    stroke-width: 2;
    pointer-events: none;
  }
  .env.faint {
    opacity: 0.35;
    stroke-width: 1.5;
    stroke-dasharray: 5 4;
  }
  .params {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 8px;
    font-size: 13px;
  }
  .plabel {
    color: var(--ink-3);
    margin-right: 2px;
  }
  .params button[role="radio"] {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    border-radius: var(--r-pill);
    background: var(--well);
    border: 1px solid var(--line);
  }
  .params button.on {
    border-color: var(--accent);
    background: rgb(var(--accent-rgb) / 0.12);
  }
  .params i {
    width: 9px;
    height: 9px;
    border-radius: 50%;
  }
  .params small {
    font-size: 10.5px;
    color: var(--accent);
  }
  :global(html[data-phone]) .phint {
    display: none;
  }
  .phint {
    color: var(--ink-3);
    font-size: 12px;
    margin-left: 6px;
  }
  .pts circle {
    stroke: var(--night-2);
    stroke-width: 2;
    cursor: move;
  }
  .pts circle.on {
    stroke: #fff;
  }
  .endbar {
    fill: #f2c94c;
    stroke: var(--night-2);
    stroke-width: 2;
    cursor: ew-resize;
  }
  .head {
    stroke: #fff;
    stroke-width: 1.5;
    pointer-events: none;
    filter: drop-shadow(0 0 2px rgb(0 0 0 / 0.7));
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
  .loading {
    fill: var(--ink-3);
    font-size: 12px;
  }
  .lanelabel {
    fill: var(--ink-2);
    font-size: 12px;
    font-weight: 600;
    pointer-events: none;
    paint-order: stroke;
    stroke: var(--night-2);
    stroke-width: 3px;
  }
  .ov {
    fill: rgb(var(--ink-rgb) / 0.05);
    cursor: pointer;
  }
  .ova {
    fill: rgb(var(--ink-rgb) / 0.5);
    pointer-events: none;
  }
  .ovb {
    fill: var(--accent);
    opacity: 0.7;
    pointer-events: none;
  }
  .ovview {
    fill: rgb(var(--ink-rgb) / 0.08);
    stroke: rgb(var(--ink-rgb) / 0.6);
    pointer-events: none;
  }
  .ovhead {
    stroke: #fff;
    pointer-events: none;
  }
  .below {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
    gap: 18px;
    margin-top: 12px;
  }
  .controls {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 18px;
  }
  .controls.off {
    opacity: 0.55;
  }
  .controls label,
  .pvol {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: var(--ink-2);
  }
  .controls b,
  .pvol b {
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  input[type="range"] {
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
  .inspector {
    min-height: 150px; /* the dialog doesn't jump when a point gets selected */
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 14px;
    border-radius: 12px;
    background: var(--well);
    border: 1px solid var(--line);
    font-size: 13px;
  }
  .inspector .btn {
    align-self: flex-start;
  }
  .ptitle {
    color: var(--ink);
    font-weight: 600;
  }
  .hint {
    color: var(--ink-3);
    line-height: 1.55;
  }
  .hint b {
    color: var(--ink-2);
  }
  .warn {
    font-size: 12.5px;
    color: rgb(240 140 120);
    margin: 8px 0 0;
  }
  .row {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-top: 16px;
  }
  .safe {
    font-size: 12px;
    color: var(--ink-3);
  }
  @media (max-width: 760px) {
    .modes {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .below {
      grid-template-columns: 1fr;
    }
  }
</style>
