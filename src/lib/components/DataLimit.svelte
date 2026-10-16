<script lang="ts">
  import { musicDir } from "../native";
  import { invoke } from "@tauri-apps/api/core";
  import { bytes } from "../format";
  import { count, LIMIT_STEPS, limitAt, songsFit, stepOf } from "../limit";
  import { settings } from "../settings.svelte";
  import { library } from "../sources/local.svelte";
  import { isAndroid } from "../platform";

  const last = LIMIT_STEPS.length; // the "No limit" stop
  let step = $state(stepOf(settings.value.dataLimit));
  const limit = $derived(limitAt(step));
  const unlimited = $derived(step === last);

  function commit() {
    settings.set("dataLimit", limit);
  }

  // Free space on the drive the music goes to.
  let disk = $state<{ free: number; total: number } | null>(null);
  $effect(() => {
    const f = settings.value.downloadFolder || library.folders[0];
    (f ? Promise.resolve(f) : musicDir())
      .then((path) => invoke<{ free: number; total: number }>("disk_space", { path }))
      .then((d) => (disk = d), () => (disk = null));
  });
  const room = $derived(disk ? disk.free + library.totalBytes : Infinity);

  /** Where a byte amount sits on the slider (stops aren't evenly spaced). */
  function posOf(b: number) {
    if (b <= LIMIT_STEPS[0]) return (b / LIMIT_STEPS[0]) * (0.5 / last);
    for (let i = 1; i < last; i++) {
      if (b <= LIMIT_STEPS[i]) return (i - 1 + (b - LIMIT_STEPS[i - 1]) / (LIMIT_STEPS[i] - LIMIT_STEPS[i - 1])) / last;
    }
    return (last - 1) / last;
  }
  const usedAt = $derived(Math.min(1, posOf(library.totalBytes)));
  const over = $derived(!unlimited && library.totalBytes > limit);
  const beyondDisk = $derived(!unlimited && limit > room);

  // Phones keep the original stream only, so there's one estimate.
  const qualities = isAndroid
    ? [
        { v: "original", label: "Standard" },
        { v: "small", label: "Space saver" },
      ]
    : [
        { v: "original", label: "Space saver" },
        { v: "best", label: "Best MP3" },
        { v: "320", label: "320 kbps" },
      ];
  const ticks = [
    { at: stepOf(1e9), label: "1 GB" },
    { at: stepOf(10e9), label: "10 GB" },
    { at: stepOf(100e9), label: "100 GB" },
    { at: stepOf(1000e9), label: "1 TB" },
    { at: last, label: "∞" },
  ].filter((t) => !(isAndroid && t.label === "1 TB")); // too close to ∞ on a phone screen
</script>

<div class="dl">
  <div class="value">
    <strong>{unlimited ? "No limit" : bytes(limit)}</strong>
    <span>
      {#if unlimited}
        Music can use all the free space{disk ? ` (${bytes(disk.free)} free now)` : ""}.
      {:else}
        for your music, about <b>{count(songsFit(limit, settings.value.quality)).replace("≈ ", "")} songs</b> at your current quality
      {/if}
    </span>
  </div>

  <div class="slider" style:--p={step / last} style:--used={usedAt}>
    <div class="track"><div class="fill"></div></div>
    {#if library.totalBytes > 0}<div class="used" title={`You have ${bytes(library.totalBytes)} now`}></div>{/if}
    <input
      type="range"
      min="0"
      max={last}
      step="1"
      bind:value={step}
      onchange={commit}
      aria-label="Data limit"
      aria-valuetext={unlimited ? "No limit" : bytes(limit)}
    />
  </div>
  <div class="ticks">
    {#each ticks as t}<button style:left={`${(t.at / last) * 100}%`} onclick={() => ((step = t.at), commit())}>{t.label}</button>{/each}
  </div>

  <div class="fits" class:one={qualities.length === 1} class:two={qualities.length === 2}>
    {#each qualities as q}
      <div class="fit" class:on={settings.value.quality === q.v}>
        <span>{q.label}</span>
        <strong>{unlimited ? (disk ? count(songsFit(room, q.v)) : "∞") : count(songsFit(limit, q.v))}</strong>
        <small>songs</small>
      </div>
    {/each}
  </div>

  <p class="foot">
    {#if library.totalBytes > 0}You have {bytes(library.totalBytes)} ({library.tracks.length.toLocaleString()} songs) now. {/if}
    {#if over}
      <span class="warn">That's less than you already have: new downloads will wait until there's room.</span>
    {:else if beyondDisk}
      <span class="warn">This drive only has room for about {bytes(room)} of music.</span>
    {:else if !unlimited}
      Downloads that would go over the limit wait, and you'll get a message.
    {/if}
    Estimates assume 3½-minute songs.
  </p>
</div>

<style>
  .dl {
    width: 100%;
  }
  .value {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }
  .value strong {
    font: 700 34px var(--font-display);
    font-variation-settings: "wdth" 85;
    font-variant-numeric: tabular-nums;
    min-width: 4.2ch;
  }
  .value span {
    color: var(--ink-2);
  }
  .value b {
    color: var(--ink);
  }
  .slider {
    position: relative;
    height: 28px;
  }
  .track {
    position: absolute;
    left: 11px;
    right: 11px;
    top: 11px;
    height: 6px;
    border-radius: 6px;
    background: rgb(var(--ink-rgb) / 0.12);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transform-origin: left;
    transform: scaleX(var(--p));
    transition: transform 120ms var(--ease-out);
  }
  /* Where your current music sits on the scale. */
  .used {
    position: absolute;
    top: 6px;
    width: 3px;
    height: 16px;
    border-radius: 2px;
    left: calc(var(--used) * (100% - 22px) + 10px);
    background: var(--ink);
    opacity: 0.55;
    pointer-events: none;
  }
  input[type="range"] {
    position: absolute;
    inset: 0;
    width: 100%;
    margin: 0;
    background: transparent;
    appearance: none;
    cursor: pointer;
  }
  input[type="range"]::-webkit-slider-runnable-track {
    height: 28px;
    background: transparent;
  }
  input[type="range"]::-webkit-slider-thumb {
    appearance: none;
    width: 22px;
    height: 22px;
    margin-top: 3px;
    border-radius: 50%;
    background: #fff;
    border: 3px solid var(--accent);
    box-shadow: 0 2px 8px rgb(0 0 0 / 0.35);
    transition: transform var(--t-fast) var(--ease-spring);
  }
  input[type="range"]:active::-webkit-slider-thumb {
    transform: scale(1.15);
  }
  .ticks {
    position: relative;
    height: 22px;
    margin: 0 11px;
  }
  .ticks button {
    position: absolute;
    translate: -50% 0;
    font-size: 11px;
    color: var(--ink-3);
    padding: 2px 4px;
  }
  .ticks button:hover {
    color: var(--ink);
  }
  .fits {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-top: 14px;
  }
  .fits.two {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .fits.one {
    grid-template-columns: minmax(0, 1fr);
  }
  .fit {
    display: flex;
    flex-direction: column;
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--well);
    border: 1px solid var(--line);
  }
  .fit.on {
    border-color: rgb(var(--accent-rgb) / 0.6);
    background: rgb(var(--accent-rgb) / 0.08);
  }
  .fit span {
    font-size: 12px;
    color: var(--ink-3);
  }
  .fit strong {
    font: 700 22px var(--font-display);
    font-variant-numeric: tabular-nums;
  }
  .fit small {
    font-size: 11px;
    color: var(--ink-3);
  }
  .foot {
    font-size: 12px;
    color: var(--ink-3);
    margin: 12px 0 0;
  }
  .warn {
    color: var(--warn);
  }
</style>
