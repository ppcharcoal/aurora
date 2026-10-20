<script lang="ts">
  // Every song-to-song step in a playlist or album, with its transition
  // (desktop). Pick None / Smooth per step, or open the editor for a custom one.
  import { fade, scale } from "svelte/transition";
  import { transitions, type PairMode } from "../transitions.svelte";
  import type { Track } from "../types";
  import { ui } from "../ui.svelte";
  import Icon from "./Icon.svelte";

  let { title, tracks }: { title: string; tracks: Track[] } = $props();

  const pairs = $derived(tracks.slice(1).map((b, i) => ({ a: tracks[i], b, n: i + 1 })));
  const defaultLabel = $derived(transitions.value.mode === "smooth" ? "Smooth" : "None");

  function current(a: Track, b: Track): PairMode | "default" {
    void transitions.version;
    return transitions.pair(a, b)?.mode ?? "default";
  }

  function choose(a: Track, b: Track, v: string) {
    if (v === "custom") ui.transitionEdit = { a, b };
    else if (v === "default") transitions.setPair(a, b, null);
    else transitions.setPair(a, b, { mode: v as PairMode, mix: transitions.pair(a, b)?.mix });
  }

  function allTo(v: "default" | "none" | "smooth") {
    for (const p of pairs) {
      const cur = transitions.pair(p.a, p.b);
      if (cur?.mode === "custom") continue; // keep hand-made ones
      if (v === "default") transitions.setPair(p.a, p.b, null);
      else transitions.setPair(p.a, p.b, { mode: v });
    }
  }

  const close = () => (ui.transitionList = null);
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && !ui.transitionEdit && close()} />

<div class="back" transition:fade={{ duration: 150 }} role="presentation" onpointerdown={close}></div>
<div class="dlg" role="dialog" aria-label={`Transitions in ${title}`} transition:scale={{ start: 0.96, duration: 180 }}>
  <header>
    <h2>Transitions</h2>
    <button class="icon" onclick={close} aria-label="Close"><Icon name="x" size={16} /></button>
  </header>
  <p class="muted sub">{title} · {pairs.length} {pairs.length === 1 ? "step" : "steps"} · Default is <b>{defaultLabel}</b> (Settings → Playback)</p>
  <div class="all">
    Set all to:
    <button class="btn sm" onclick={() => allTo("default")}>Default</button>
    <button class="btn sm" onclick={() => allTo("none")}>None</button>
    <button class="btn sm" onclick={() => allTo("smooth")}>Smooth</button>
    <small>(custom ones stay)</small>
  </div>
  {#if !pairs.length}
    <p class="muted">Add at least two songs to make transitions.</p>
  {:else}
    <ol class="pairs">
      {#each pairs as p (p.n + p.a.key + p.b.key)}
        {@const mode = current(p.a, p.b)}
        <li>
          <span class="n">{p.n}</span>
          <span class="songs">
            <span class="t">{p.a.title}</span>
            <Icon name="next" size={12} />
            <span class="t">{p.b.title}</span>
          </span>
          <select class="field" value={mode} onchange={(e) => choose(p.a, p.b, e.currentTarget.value)} aria-label={`Transition from ${p.a.title} to ${p.b.title}`}>
            <option value="default">Default ({defaultLabel})</option>
            <option value="none">None</option>
            <option value="smooth">Smooth</option>
            <option value="custom">Custom…</option>
          </select>
          <button class="btn sm" class:on={mode === "custom"} onclick={() => (ui.transitionEdit = { a: p.a, b: p.b })} title="Open the transition editor">
            <Icon name="edit" size={14} /> {mode === "custom" ? "Edit" : "Customise"}
          </button>
        </li>
      {/each}
    </ol>
  {/if}
  <p class="note">Transitions only change how Aurora plays one song into the next. The music files aren't edited, and they play normally anywhere else. A custom transition is used wherever these two songs play in this order (playlists, albums, the queue).</p>
</div>

<style>
  .back {
    position: fixed;
    inset: 0;
    z-index: 55;
    background: rgb(10 8 14 / 0.55);
  }
  .dlg {
    position: fixed;
    z-index: 56;
    left: 50%;
    top: 50%;
    translate: -50% -50%;
    width: min(760px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    overflow: auto;
    padding: 22px 24px;
    border-radius: var(--r-panel);
    background: var(--night-2);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    font-size: 22px;
  }
  .sub {
    margin: 4px 0 12px;
    font-size: 13px;
  }
  .all {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 13px;
    color: var(--ink-2);
    margin-bottom: 12px;
  }
  .all small {
    color: var(--ink-3);
  }
  .btn.sm {
    height: 30px;
    padding: 0 12px;
    font-size: 13px;
  }
  .btn.on {
    border-color: var(--accent);
    color: var(--accent);
  }
  .pairs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .pairs li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 8px 8px 12px;
    border-radius: 12px;
    background: var(--well);
    border: 1px solid var(--line);
  }
  .n {
    width: 22px;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
    font-size: 13px;
  }
  .songs {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--ink-3);
  }
  .t {
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  select.field {
    width: 150px;
    height: 32px;
    padding: 0 8px;
  }
  .note {
    font-size: 12.5px;
    color: var(--ink-3);
    margin: 14px 0 0;
  }
</style>
