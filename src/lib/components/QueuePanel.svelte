<script lang="ts">
  import { fly } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { player } from "../player.svelte";
  import { settings } from "../settings.svelte";
  import { ui } from "../ui.svelte";
  import Artwork from "./Artwork.svelte";
  import Bars from "./Bars.svelte";
  import Icon from "./Icon.svelte";

  const d = $derived(settings.value.reduceMotion ? 0 : 1);
  // Only render a window of upcoming items; queues can be thousands long.
  const upcoming = $derived(player.upNext.slice(0, 80));
</script>

<aside class="queue" transition:fly={{ x: 360 * d, duration: 380 * d, opacity: 1 }}>
  <div class="hd">
    <h2>Queue</h2>
    <button class="x" onclick={() => (ui.queueOpen = false)} aria-label="Close queue"><Icon name="x" size={16} /></button>
  </div>

  {#if player.current}
    {@const t = player.current}
    <h3 class="lbl">Now playing</h3>
    <div class="item now">
      <Artwork src={t.art} size={44} radius="6px" />
      <div class="txt">
        <div class="t">{t.title}</div>
        <div class="s">{t.artist}</div>
      </div>
      <Bars paused={!player.playing} />
    </div>
  {/if}

  <h3 class="lbl">Up next</h3>
  {#if upcoming.length === 0}
    <p class="muted empty-q">Nothing queued. Use the + on any song to add it here.</p>
  {/if}
  <div class="scroll">
    {#each upcoming as t, k (t.key + k)}
      <div class="item" animate:flip={{ duration: 260 * d }}>
        <button class="hit" onclick={() => player.jumpTo(player.index + 1 + k)} aria-label={`Play ${t.title}`}></button>
        <Artwork src={t.art} size={44} radius="6px" />
        <div class="txt">
          <div class="t">{t.title}</div>
          <div class="s">{t.artist}</div>
        </div>
        <button class="rm" onclick={() => player.removeAt(player.index + 1 + k)} aria-label="Remove from queue">
          <Icon name="x" size={14} />
        </button>
      </div>
    {/each}
    {#if player.upNext.length > upcoming.length}
      <p class="muted more">and {player.upNext.length - upcoming.length} more</p>
    {/if}
  </div>
</aside>

<style>
  .queue {
    position: absolute;
    top: 0;
    right: var(--gutter);
    bottom: 0;
    width: 340px;
    border-radius: var(--r-panel);
    box-shadow: var(--shadow);
    z-index: 3;
    display: flex;
    flex-direction: column;
    padding: 16px 12px 12px 16px;
    background: var(--glass-strong);
    backdrop-filter: blur(30px) saturate(1.3);
    border: 1px solid var(--line);
  }
  :global(html[data-phone]) .queue {
    position: fixed;
    inset: 0;
    width: auto;
    z-index: 40;
    border-radius: 0;
    border: 0;
    padding: calc(var(--safe-top) + 14px) 14px calc(var(--safe-bottom) + 12px) 16px;
    background: var(--panel-solid);
  }
  .hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    font-size: 22px;
  }
  .x {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--ink-2);
  }
  .x:hover {
    background: rgb(var(--ink-rgb) / 0.08);
    color: var(--ink);
  }
  .lbl {
    font: 600 13px var(--font-ui);
    color: var(--ink-3);
    margin: 18px 0 8px;
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    margin-right: -8px;
    padding-right: 4px;
  }
  .item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px;
    border-radius: 10px;
    transition: background var(--t-fast);
  }
  .item:hover {
    background: rgb(var(--ink-rgb) / 0.06);
  }
  .now {
    background: rgb(var(--accent-rgb) / 0.1);
  }
  .hit {
    position: absolute;
    inset: 0;
    border-radius: 10px;
  }
  .txt {
    flex: 1;
    min-width: 0;
  }
  .t {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .now .t {
    color: var(--accent);
  }
  .s {
    display: flex;
    gap: 5px;
    align-items: center;
    font-size: 12px;
    color: var(--ink-2);
    white-space: nowrap;
    overflow: hidden;
  }
  .rm {
    position: relative;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--ink-3);
    opacity: 0;
    transition: opacity var(--t-fast);
  }
  .item:hover .rm,
  .rm:focus-visible {
    opacity: 1;
  }
  .rm:hover {
    color: var(--ink);
    background: rgb(var(--ink-rgb) / 0.1);
  }
  .empty-q,
  .more {
    font-size: 13px;
    padding: 0 6px;
  }
</style>
