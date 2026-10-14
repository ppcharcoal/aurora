<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import { isAndroid } from "../platform";
  import { player } from "../player.svelte";
  import { settings } from "../settings.svelte";
  import { BANDS, spectrum } from "../spectrum";
  import { ui } from "../ui.svelte";
  import Artwork from "./Artwork.svelte";
  import Icon from "./Icon.svelte";

  // Full-screen visualizer: a modern take on the old Windows Media Player ones.
  // Colours follow the song's cover (the app's accent colour).

  const MODES = [
    { id: "aurora", name: "Aurora", note: "Northern lights" },
    { id: "bars", name: "Spectrum", note: "Bars and peaks" },
    { id: "halo", name: "Halo", note: "Around the cover" },
    { id: "ambience", name: "Ambience", note: "Swirl" },
  ] as const;
  type Mode = (typeof MODES)[number]["id"];

  const t = $derived(player.current);
  let mode = $state(Math.min(MODES.length - 1, Math.max(0, settings.value.vizMode | 0)));
  let chrome = $state(true);
  let canvas: HTMLCanvasElement;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function setMode(i: number) {
    mode = (i + MODES.length) % MODES.length;
    settings.set("vizMode", mode);
    poke();
  }

  function poke() {
    chrome = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => (chrome = false), 3000);
  }

  function close() {
    if (isAndroid && history.state?.aurViz) history.back();
    else ui.vizOpen = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowUp") setMode(mode - 1);
    else if (e.key === "ArrowDown") setMode(mode + 1);
    else return;
    e.preventDefault();
  }

  /* ---------------- colours ---------------- */

  type RGB = [number, number, number];
  let colA: RGB = [94, 224, 196];
  let colB: RGB = [157, 123, 255];

  function rgbToHsl([r, g, b]: RGB): [number, number, number] {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hslToRgb(h: number, s: number, l: number): RGB {
    h = (((h % 360) + 360) % 360) / 360;
    const f = (n: number) => {
      const k = (n + h * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  }
  function readColours() {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--accent-rgb").trim().split(/[\s,]+/).map(Number);
    if (v.length === 3 && v.every((n) => Number.isFinite(n))) colA = v as RGB;
    const [h, s, l] = rgbToHsl(colA);
    // The second colour: the accent turned around the colour wheel, kept vivid.
    colB = hslToRgb(h + 55, Math.max(0.55, s), Math.min(0.68, Math.max(0.55, l)));
  }
  const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

  /* ---------------- cover image for Halo ---------------- */

  let cover: HTMLImageElement | null = null;
  $effect(() => {
    const src = t?.art;
    cover = null;
    if (!src) return;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => (cover = img);
    img.src = src;
  });

  /* ---------------- drawing ---------------- */

  const peaks = new Float32Array(BANDS);
  const ripples: { r: number; a: number }[] = [];
  const sparks: { x: number; y: number; vx: number; vy: number; life: number; c: RGB }[] = [];
  const stars = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random() * 0.55, s: Math.random() * 1.4 + 0.4, p: Math.random() * 6.28 }));
  let spin = 0;
  let buffer: HTMLCanvasElement | null = null;

  function level(x: number) {
    // Smooth level at a position 0–1 across the bands.
    const f = Math.max(0, Math.min(BANDS - 1.001, x * (BANDS - 1)));
    const i = Math.floor(f);
    const k = f - i;
    return spectrum.levels[i] * (1 - k) + spectrum.levels[i + 1] * k;
  }

  function aurora(g: CanvasRenderingContext2D, w: number, h: number, time: number) {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#04040a");
    bg.addColorStop(1, rgba(mix([6, 6, 14], colA, 0.12), 1));
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    for (const s of stars) {
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(time * 0.6 + s.p)) * (0.5 + spectrum.treble);
      g.fillStyle = `rgba(255,255,255,${0.12 + tw * 0.35})`;
      g.fillRect(s.x * w, s.y * h, s.s, s.s);
    }

    g.globalCompositeOperation = "lighter";
    const parts = [spectrum.bass, spectrum.mid * 1.2, spectrum.treble * 1.5, spectrum.energy];
    for (let k = 0; k < 4; k++) {
      const c = mix(colA, colB, k / 3);
      const baseY = h * (0.5 + k * 0.06);
      const amp = h * (0.03 + 0.16 * parts[k]);
      const curtain = h * (0.18 + 0.22 * parts[k]);
      const step = Math.max(6, w / 160);
      const ys: number[] = [];
      for (let x = 0; x <= w + step; x += step) {
        const u = x / w;
        const y =
          baseY +
          Math.sin(u * (3 + k) + time * (0.4 + k * 0.13) + k * 1.7) * amp +
          Math.sin(u * 9 - time * 0.9 + k) * amp * 0.25 -
          level(k % 2 ? 1 - u : u) * h * 0.14;
        ys.push(y);
      }
      // The glowing curtain hanging up from the line.
      const grad = g.createLinearGradient(0, baseY - curtain - amp, 0, baseY + amp);
      grad.addColorStop(0, rgba(c, 0));
      grad.addColorStop(0.75, rgba(c, 0.16 + parts[k] * 0.25));
      grad.addColorStop(1, rgba(c, 0));
      g.fillStyle = grad;
      g.beginPath();
      ys.forEach((y, i) => g.lineTo(i * step, y - curtain));
      for (let i = ys.length - 1; i >= 0; i--) g.lineTo(i * step, ys[i] + 6);
      g.closePath();
      g.fill();
      // The bright edge.
      g.beginPath();
      ys.forEach((y, i) => (i ? g.lineTo(i * step, y) : g.moveTo(0, y)));
      g.strokeStyle = rgba(c, 0.1 + parts[k] * 0.2);
      g.lineWidth = 9;
      g.stroke();
      g.strokeStyle = rgba(mix(c, [255, 255, 255], 0.35), 0.55 + parts[k] * 0.45);
      g.lineWidth = 1.6;
      g.stroke();
    }
    g.globalCompositeOperation = "source-over";
  }

  function bars(g: CanvasRenderingContext2D, w: number, h: number) {
    g.fillStyle = "#05050a";
    g.fillRect(0, 0, w, h);
    const glow = g.createRadialGradient(w / 2, h * 0.62, 0, w / 2, h * 0.62, Math.max(w, h) * 0.7);
    glow.addColorStop(0, rgba(colA, 0.1 + spectrum.energy * 0.25));
    glow.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);

    const n = BANDS;
    const pad = w * 0.06;
    const slot = (w - pad * 2) / n;
    const bw = Math.max(2, slot * 0.62);
    const base = h * 0.64;
    const maxH = h * 0.5;
    const grad = g.createLinearGradient(0, base - maxH, 0, base);
    grad.addColorStop(0, rgba(mix(colB, [255, 255, 255], 0.2), 1));
    grad.addColorStop(1, rgba(colA, 1));
    for (let i = 0; i < n; i++) {
      const v = Math.pow(spectrum.levels[i], 1.35);
      const bh = Math.max(3, v * maxH);
      const x = pad + i * slot + (slot - bw) / 2;
      g.fillStyle = grad;
      g.beginPath();
      g.roundRect(x, base - bh, bw, bh, Math.min(bw / 2, 6));
      g.fill();
      // Reflection.
      g.fillStyle = rgba(colA, 0.12);
      g.fillRect(x, base + 4, bw, bh * 0.35);
      // Peak caps fall slowly.
      peaks[i] = Math.max(peaks[i] - 0.006, v);
      g.fillStyle = rgba(mix(colB, [255, 255, 255], 0.5), 0.9);
      g.fillRect(x, base - peaks[i] * maxH - 7, bw, 3);
    }
    const fadeOut = g.createLinearGradient(0, base, 0, h);
    fadeOut.addColorStop(0, "rgba(5,5,10,0.1)");
    fadeOut.addColorStop(0.5, "rgba(5,5,10,1)");
    g.fillStyle = fadeOut;
    g.fillRect(0, base + 2, w, h - base);
  }

  function halo(g: CanvasRenderingContext2D, w: number, h: number, dt: number) {
    g.fillStyle = "#05050a";
    g.fillRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h * 0.46;
    const m = Math.min(w, h);
    const R = m * 0.2 * (1 + spectrum.beat * 0.06);
    const bg = g.createRadialGradient(cx, cy, R, cx, cy, m * 0.75);
    bg.addColorStop(0, rgba(colA, 0.08 + spectrum.energy * 0.22));
    bg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    if (spectrum.beat > 0.35 && (!ripples.length || ripples[ripples.length - 1].r > R * 1.25)) ripples.push({ r: R, a: 0.5 });
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.r += m * 0.25 * dt;
      r.a -= 0.5 * dt;
      if (r.a <= 0) {
        ripples.splice(i, 1);
        continue;
      }
      g.strokeStyle = rgba(colB, r.a);
      g.lineWidth = 2;
      g.beginPath();
      g.arc(cx, cy, r.r, 0, Math.PI * 2);
      g.stroke();
    }

    // Spectrum around the cover: mirrored so it's symmetric.
    const n = BANDS * 2;
    g.lineCap = "round";
    g.lineWidth = Math.max(2, ((Math.PI * 2 * R) / n) * 0.5);
    for (let i = 0; i < n; i++) {
      const b = i < BANDS ? i : n - 1 - i;
      const v = spectrum.levels[b];
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const len = 4 + Math.pow(v, 1.2) * m * 0.2;
      const c = mix(colA, colB, b / BANDS);
      g.strokeStyle = rgba(c, 0.55 + v * 0.45);
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (R + 10), cy + Math.sin(a) * (R + 10));
      g.lineTo(cx + Math.cos(a) * (R + 10 + len), cy + Math.sin(a) * (R + 10 + len));
      g.stroke();
    }

    // The cover as a spinning disc.
    if (player.playing) spin += dt * 0.35;
    g.save();
    g.translate(cx, cy);
    g.rotate(spin);
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.clip();
    if (cover) g.drawImage(cover, -R, -R, R * 2, R * 2);
    else {
      g.fillStyle = rgba(colA, 0.8);
      g.fillRect(-R, -R, R * 2, R * 2);
    }
    g.restore();
    g.strokeStyle = "rgba(255,255,255,0.18)";
    g.lineWidth = 2;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = "#05050a";
    g.beginPath();
    g.arc(cx, cy, R * 0.07, 0, Math.PI * 2);
    g.fill();
  }

  function ambience(g: CanvasRenderingContext2D, w: number, h: number, time: number, dt: number) {
    // Feedback: last frame, slightly zoomed and turned, fading out. That's the
    // classic Windows Media Player "Ambience" trail, done with two canvases.
    if (!buffer || buffer.width !== g.canvas.width || buffer.height !== g.canvas.height) {
      buffer = document.createElement("canvas");
      buffer.width = g.canvas.width;
      buffer.height = g.canvas.height;
    }
    const b = buffer.getContext("2d")!;
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.clearRect(0, 0, buffer.width, buffer.height);
    b.drawImage(g.canvas, 0, 0);

    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "#030308";
    g.fillRect(0, 0, g.canvas.width, g.canvas.height);
    g.restore();

    const cx = w / 2;
    const cy = h / 2;
    g.save();
    g.globalAlpha = 0.9;
    g.translate(cx, cy);
    g.rotate(0.006 + spectrum.mid * 0.02);
    const z = 1.012 + spectrum.energy * 0.03 + spectrum.beat * 0.02;
    g.scale(z, z);
    g.translate(-cx, -cy);
    g.drawImage(buffer, 0, 0, w, h);
    g.restore();

    // New strokes: a turning flower whose petals follow the music.
    g.globalCompositeOperation = "lighter";
    const m = Math.min(w, h);
    const [hA] = rgbToHsl(colA);
    const petals = 3 + Math.round(2 + Math.sin(time * 0.07) * 2);
    for (let layer = 0; layer < 2; layer++) {
      const hue = hA + Math.sin(time * 0.2) * 40 + layer * 70;
      const c = hslToRgb(hue, 0.85, 0.6);
      const R = m * (0.12 + 0.2 * (layer ? spectrum.treble : spectrum.bass) + 0.05 * spectrum.beat);
      g.strokeStyle = rgba(c, 0.55);
      g.lineWidth = 1.5 + spectrum.energy * 3;
      g.beginPath();
      for (let i = 0; i <= 240; i++) {
        const a = (i / 240) * Math.PI * 2;
        const r = R * (0.55 + 0.45 * Math.sin(petals * a + time * (layer ? -0.9 : 0.7))) * (1 + level(i / 240) * 0.5);
        const x = cx + Math.cos(a + time * 0.3) * r;
        const y = cy + Math.sin(a + time * 0.3) * r;
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.stroke();
    }
    // Sparks on the beat.
    if (spectrum.beat > 0.3) {
      for (let i = 0; i < 14; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = m * (0.15 + Math.random() * 0.35);
        sparks.push({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, c: Math.random() > 0.5 ? colA : colB });
      }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= dt * 1.2;
      if (s.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      g.fillStyle = rgba(s.c, s.life);
      g.fillRect(s.x - 1.5, s.y - 1.5, 3, 3);
    }
    if (sparks.length > 400) sparks.splice(0, sparks.length - 400);
    g.globalCompositeOperation = "source-over";
  }

  onMount(() => {
    spectrum.start();
    readColours();
    poke();
    if (isAndroid) history.pushState({ aurViz: true }, "");
    const onPop = () => (ui.vizOpen = false);
    window.addEventListener("popstate", onPop);

    const g = canvas.getContext("2d", { alpha: false })!;
    // Phones: fewer pixels keeps it smooth and easy on the battery.
    const scale = Math.min(window.devicePixelRatio || 1, isAndroid ? 1.25 : 2);
    let w = 0;
    let h = 0;
    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    let last = performance.now();
    let colourAt = 0;
    let drawn = -1;
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const time = now / 1000;
      if (now - colourAt > 1000) {
        readColours();
        colourAt = now;
      }
      spectrum.update();
      if (drawn !== mode) {
        // New style: start from a clean screen (Ambience would trail the old one).
        drawn = mode;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.fillStyle = "#05050a";
        g.fillRect(0, 0, canvas.width, canvas.height);
        buffer = null;
        sparks.length = 0;
        ripples.length = 0;
      }
      g.setTransform(scale, 0, 0, scale, 0, 0);
      const id: Mode = MODES[mode].id;
      if (id === "aurora") aurora(g, w, h, time);
      else if (id === "bars") bars(g, w, h);
      else if (id === "halo") halo(g, w, h, dt);
      else ambience(g, w, h, time, dt);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      clearTimeout(hideTimer);
      window.removeEventListener("popstate", onPop);
      spectrum.stop();
    };
  });

  $effect(() => {
    if (!t) close();
  });
</script>

<svelte:window onkeydown={onKey} />

<div
  class="viz"
  class:bare={!chrome}
  role="dialog"
  aria-label="Visualizer"
  tabindex="-1"
  onpointermove={poke}
  onpointerdown={poke}
  transition:fade={{ duration: 220 }}
>
  <canvas bind:this={canvas} aria-hidden="true"></canvas>

  {#if chrome}
    <div class="top" transition:fade={{ duration: 180 }}>
      <button class="round" onclick={close} aria-label="Close the visualizer" title="Close (Esc)"><Icon name="x" size={20} /></button>
    </div>

    {#if spectrum.unavailable}
      <p class="msg" transition:fade={{ duration: 180 }}>{spectrum.unavailable}</p>
    {/if}

    <div class="bottom" transition:fade={{ duration: 180 }}>
      <div class="modes">
        <button class="round sm prev" onclick={() => setMode(mode - 1)} aria-label="Previous style"><Icon name="chevron" size={18} /></button>
        <div class="name"><strong>{MODES[mode].name}</strong><small>{MODES[mode].note}</small></div>
        <button class="round sm" onclick={() => setMode(mode + 1)} aria-label="Next style"><Icon name="chevron" size={18} /></button>
      </div>
      {#if t}
        <div class="now">
          <Artwork src={t.art} size={48} radius="8px" />
          <div class="txt">
            <div class="tt">{t.title}</div>
            <div class="ta">{t.artist}</div>
          </div>
          <div class="ctl">
            <button class="round" onclick={() => player.prev()} aria-label="Previous"><Icon name="prev" size={20} /></button>
            <button class="round play" onclick={() => player.toggle()} aria-label={player.playing ? "Pause" : "Play"}>
              <Icon name={player.playing ? "pause" : "play"} size={22} />
            </button>
            <button class="round" onclick={() => player.next()} aria-label="Next"><Icon name="next" size={20} /></button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .viz {
    position: fixed;
    inset: 0;
    z-index: 300;
    background: #05050a;
    color: #fff;
    outline: none;
  }
  .viz.bare {
    cursor: none;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  .top {
    position: absolute;
    top: calc(var(--safe-top, 0px) + 14px);
    right: 16px;
  }
  .round {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: #fff;
    background: rgb(255 255 255 / 0.1);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    transition:
      background var(--t-fast),
      transform var(--t-fast) var(--ease-out);
  }
  .round:hover {
    background: rgb(255 255 255 / 0.18);
  }
  .round:active {
    transform: scale(0.94);
  }
  .round.sm {
    width: 34px;
    height: 34px;
  }
  .round.sm.prev :global(svg) {
    transform: rotate(180deg);
  }
  .round.play {
    width: 52px;
    height: 52px;
    color: var(--on-accent, #05050a);
    background: var(--accent);
  }
  .msg {
    position: absolute;
    top: calc(var(--safe-top, 0px) + 24px);
    left: 16px;
    right: 76px;
    margin: 0;
    font-size: 13px;
    color: rgb(255 255 255 / 0.7);
  }
  .bottom {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 18px 16px calc(var(--safe-bottom, 0px) + 18px);
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
    justify-items: center;
    background: linear-gradient(transparent, rgb(0 0 0 / 0.55));
  }
  .modes {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .name {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 120px;
  }
  .name strong {
    font-family: var(--font-display);
    font-size: 18px;
    letter-spacing: 0.01em;
  }
  .name small {
    font-size: 12px;
    color: rgb(255 255 255 / 0.6);
  }
  .now {
    width: min(560px, 100%);
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 18px;
    background: rgb(255 255 255 / 0.07);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
  }
  .txt {
    flex: 1;
    min-width: 0;
  }
  .tt,
  .ta {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tt {
    font-weight: 600;
  }
  .ta {
    font-size: 13px;
    color: rgb(255 255 255 / 0.65);
  }
  .ctl {
    display: flex;
    align-items: center;
    gap: 8px;
  }
</style>
