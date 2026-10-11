<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { openPath } from "@tauri-apps/plugin-opener";
  import { bytes } from "../format";
  import { settings } from "../settings.svelte";
  import { library } from "../sources/local.svelte";
  import { downloads } from "../downloads.svelte";
  import { ui } from "../ui.svelte";

  // How much space your music takes, and how much is left on that drive.
  const folder = $derived(settings.value.downloadFolder || library.folders[0] || "");
  let disk = $state<{ free: number; total: number } | null>(null);

  $effect(() => {
    const f = folder;
    library.totalBytes; // refresh after scans and downloads
    downloads.active;
    if (!f) return;
    invoke<{ free: number; total: number }>("disk_space", { path: f }).then(
      (d) => (disk = d),
      () => (disk = null),
    );
  });

  const share = $derived(disk && disk.total ? Math.min(1, library.totalBytes / disk.total) : 0);
  const used = $derived(disk && disk.total ? 1 - disk.free / disk.total : 0);
  const low = $derived(!!disk && disk.free < 5e9);
  // With a data limit the bar shows how full the limit is instead of the drive.
  const limit = $derived(settings.value.dataLimit);
  const ofLimit = $derived(limit ? Math.min(1, library.totalBytes / limit) : 0);
  const nearLimit = $derived(!!limit && ofLimit > 0.9);
</script>

{#if folder}
  <button class="meter" onclick={() => openPath(folder).catch(ui.error)} title={`Open ${folder}`}>
    <div class="row">
      <span>Music</span>
      <strong>{bytes(library.totalBytes)}{#if limit}<span class="of">&nbsp;of {bytes(limit)}</span>{/if}</strong>
    </div>
    {#if limit}
      <div class="bar" role="img" aria-label={`Music uses ${bytes(library.totalBytes)} of your ${bytes(limit)} limit`}>
        <div class="mine" class:full={nearLimit} style:transform={`scaleX(${ofLimit})`}></div>
      </div>
      <div class="free" class:low={nearLimit}>{bytes(Math.max(0, limit - library.totalBytes))} left in your limit</div>
    {:else if disk}
      <div class="bar" role="img" aria-label={`Music uses ${bytes(library.totalBytes)}; ${bytes(disk.free)} free of ${bytes(disk.total)}`}>
        <div class="other" style:transform={`scaleX(${used})`}></div>
        <div class="mine" style:transform={`scaleX(${share})`}></div>
      </div>
      <div class="free" class:low>{bytes(disk.free)} free on this drive</div>
    {/if}
  </button>
{/if}

<style>
  .meter {
    display: block;
    width: 100%;
    text-align: left;
    padding: 10px 12px;
    margin-bottom: 8px;
    border-radius: 12px;
    transition: background var(--t-fast);
  }
  .meter:hover {
    background: rgb(var(--ink-rgb) / 0.05);
  }
  .row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--ink-3);
  }
  .row strong {
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .bar {
    position: relative;
    height: 5px;
    margin: 7px 0 5px;
    border-radius: 5px;
    overflow: hidden;
    background: rgb(var(--ink-rgb) / 0.1);
  }
  .bar div {
    position: absolute;
    inset: 0;
    transform-origin: left;
    transition: transform var(--t-med) var(--ease-out);
  }
  /* Everything else on the drive, then your music on top of it. */
  .other {
    background: rgb(var(--ink-rgb) / 0.22);
  }
  .mine {
    background: var(--accent);
  }
  .of {
    font-weight: 400;
    color: var(--ink-3);
  }
  .mine.full {
    background: var(--warn);
  }
  .free {
    font-size: 11px;
    color: var(--ink-3);
  }
  .free.low {
    color: var(--warn);
  }
</style>
