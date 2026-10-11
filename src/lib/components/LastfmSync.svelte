<script lang="ts">
  import { isAndroid } from "../platform";
  import { invoke } from "@tauri-apps/api/core";
  import { downloads } from "../downloads.svelte";
  import { lastfm, type SyncItem } from "../lastfm.svelte";
  import { player } from "../player.svelte";
  import type { AlbumResult, CatalogTrack } from "../types";
  import { ui } from "../ui.svelte";
  import Artwork from "./Artwork.svelte";
  import Icon from "./Icon.svelte";
  import PreviewButton from "./PreviewButton.svelte";
  import { previewSource } from "../preview.svelte";
  import { approx } from "../format";
  import { settings } from "../settings.svelte";

  // What you play anywhere (phone, other PCs, Spotify…) is scrobbled to
  // Last.fm. Comparing that with this library shows what's missing here.
  type Opts = { recent: boolean; loved: boolean; top: boolean; albums: boolean; period: string };
  let opts = $state<Opts>(load());
  let showHave = $state(false);
  let items = $state<SyncItem[]>([]);
  let checking = $state(false);
  let looking = $state(false);
  let checkedAt = $state<number | null>(null);

  function load(): Opts {
    try {
      return { recent: true, loved: true, top: true, albums: true, period: "3month", ...JSON.parse(localStorage.getItem("aurora.sync") ?? "{}") };
    } catch {
      return { recent: true, loved: true, top: true, albums: true, period: "3month" };
    }
  }
  $effect(() => {
    try {
      localStorage.setItem("aurora.sync", JSON.stringify($state.snapshot(opts)));
    } catch {
      /* ignore */
    }
  });

  async function check() {
    checking = true;
    try {
      items = await lastfm.syncList($state.snapshot(opts));
      checkedAt = Date.now();
      lookUp();
    } catch (e) {
      ui.error(e);
    } finally {
      checking = false;
    }
  }

  /** Finds each missing song/album in the music catalog (covers, real titles, durations). */
  async function lookUp() {
    looking = true;
    try {
      const songs = items.filter((i) => i.kind === "song" && !i.have && !i.looked);
      for (let i = 0; i < songs.length; i += 30) {
        const batch = songs.slice(i, i + 30);
        const found = await invoke<(CatalogTrack | null)[]>("catalog_match_tracks", {
          items: batch.map((b) => ({ artist: b.artist, title: b.title })),
        });
        batch.forEach((b, j) => {
          b.catalog = found[j];
          b.looked = true;
        });
        items = [...items];
      }
      for (const a of items.filter((i) => i.kind === "album" && !i.have && !i.looked)) {
        a.album = await invoke<AlbumResult | null>("catalog_match_album", { artist: a.artist, album: a.title }).catch(() => null);
        a.looked = true;
        items = [...items];
      }
    } finally {
      looking = false;
    }
  }

  const missing = $derived(items.filter((i) => !i.have));
  const available = $derived(missing.filter((i) => (i.kind === "song" ? i.catalog : i.album)));
  const notFound = $derived(missing.filter((i) => i.looked && !(i.kind === "song" ? i.catalog : i.album)));
  const shown = $derived(showHave ? items : missing);
  const totalEst = $derived(
    approx(
      available.reduce((s, i) => s + (i.catalog ? i.catalog.durationMs : (i.album?.tracks.reduce((x, t) => x + t.durationMs, 0) ?? 0)), 0),
      settings.value.quality,
    ),
  );

  function statusOf(i: SyncItem) {
    if (i.kind === "album" && i.album) return downloads.albumStatus(i.album);
    if (i.catalog) return downloads.status(i.catalog.id);
  }
  const busy = (i: SyncItem) => {
    const s = statusOf(i);
    return s && (s.status === "queued" || s.status === "downloading" || s.status === "converting");
  };
  const owned = (i: SyncItem) => i.have || (i.catalog && downloads.trackFor(i.catalog.id, i.catalog)) || (statusOf(i)?.status === "done");

  function get(i: SyncItem) {
    if (i.kind === "album" && i.album) downloads.enqueueAlbum(i.album);
    else if (i.catalog) downloads.enqueueCatalog(i.catalog, undefined, { quiet: true });
  }

  function getAll() {
    const list = available.filter((i) => !owned(i) && !busy(i));
    // Albums first, then loose songs that aren't on one of those albums.
    const albumTitles = new Set(list.filter((i) => i.kind === "album").map((i) => i.album!.title.toLowerCase()));
    for (const i of list) {
      if (i.kind === "song" && i.catalog?.album && albumTitles.has(i.catalog.album.toLowerCase())) continue;
      get(i);
    }
    ui.toast(`Queued ${list.length} downloads`, "success");
  }

  const playHave = (i: SyncItem) => {
    const t = lastfm.find(i.artist, i.title) ?? (i.catalog ? downloads.trackFor(i.catalog.id, i.catalog) : undefined);
    if (t) player.playList([t], 0);
  };
  const periods = [
    ["7day", "Last 7 days"],
    ["1month", "Last month"],
    ["3month", "Last 3 months"],
    ["12month", "Last year"],
    ["overall", "All time"],
  ];
</script>

{#if !lastfm.connected}
  <div class="empty">
    <h2>Connect Last.fm to sync</h2>
    <p>
      Last.fm keeps track of what you play on every device. Once it's connected, this tab compares that with the music on this {isAndroid ? "phone" : "PC"}
      and downloads what's missing, so all your devices end up with the same songs.
    </p>
    <button class="btn primary" onclick={() => ui.go({ name: "profile" })}><Icon name="link" size={16} /> Set up Last.fm</button>
  </div>
{:else}
  <div class="bar">
    <div class="chips" role="group" aria-label="What to check">
      <button class:on={opts.recent} aria-pressed={opts.recent} onclick={() => (opts.recent = !opts.recent)}>Played recently</button>
      <button class:on={opts.loved} aria-pressed={opts.loved} onclick={() => (opts.loved = !opts.loved)}>Loved</button>
      <button class:on={opts.top} aria-pressed={opts.top} onclick={() => (opts.top = !opts.top)}>Top songs</button>
      <button class:on={opts.albums} aria-pressed={opts.albums} onclick={() => (opts.albums = !opts.albums)}>Top albums</button>
      <select class="field period" bind:value={opts.period} aria-label="Period for top songs and albums">
        {#each periods as [v, l]}<option value={v}>{l}</option>{/each}
      </select>
    </div>
    <button class="btn primary" onclick={check} disabled={checking || !(opts.recent || opts.loved || opts.top || opts.albums)}>
      <Icon name="refresh" size={15} /> {checking ? "Checking…" : items.length ? "Check again" : "Check what's missing"}
    </button>
  </div>

  {#if checkedAt}
    <div class="summary">
      <div class="nums">
        <div><strong>{items.length - missing.length}</strong><span>already here</span></div>
        <div><strong>{missing.length}</strong><span>missing</span></div>
        <div><strong>{available.length}</strong><span>{looking ? "found so far" : "can be downloaded"}</span></div>
        {#if notFound.length}<div><strong>{notFound.length}</strong><span>not found</span></div>{/if}
      </div>
      <div class="acts">
        <label class="mini"><input type="checkbox" bind:checked={showHave} /> Show what I have</label>
        <button class="btn primary" onclick={getAll} disabled={!available.length}>
          <Icon name="download" size={15} /> Download {available.length ? `all ${available.length}` : "all"}{totalEst ? ` (${totalEst})` : ""}
        </button>
      </div>
    </div>

    <ul class="rows">
      {#each shown as i (i.key)}
        {@const st = statusOf(i)}
        {@const art = i.kind === "album" ? i.album?.thumb : i.catalog?.cover}
        <li class:have={owned(i)}>
          <Artwork src={art ?? undefined} size={44} radius={i.kind === "album" ? "6px" : "6px"} />
          <div class="txt">
            <div class="tt">{#if i.kind === "album"}<span class="tag">Album</span>{/if}{i.title}</div>
            <div class="ta">{i.artist}{i.kind === "album" && i.album ? ` — ${i.album.tracks.length} songs` : ""}{#if !owned(i) && (i.catalog || i.album)} · {approx(i.catalog ? i.catalog.durationMs : i.album!.tracks.reduce((s, t) => s + t.durationMs, 0), settings.value.quality)}{/if}</div>
          </div>
          <span class="why">{i.reason}{i.plays ? ` · ${i.plays} plays` : ""}</span>
          {#if !owned(i) && i.catalog?.preview}<PreviewButton key={"sync:" + i.key} src={previewSource({ preview: i.catalog.preview })!} size={30} />{:else}<span></span>{/if}
          <div class="state">
            {#if owned(i)}
              <button class="btn small done" onclick={() => playHave(i)} disabled={i.kind === "album"}><Icon name="check" size={14} stroke={2.4} /> Here</button>
            {:else if busy(i)}
              <span class="muted small">{st?.status === "queued" ? "Queued" : `${Math.round(st?.percent ?? 0)}%`}</span>
            {:else if st?.status === "error"}
              <button class="btn small" onclick={() => get(i)} title={st.error}>Retry</button>
            {:else if i.kind === "song" ? i.catalog : i.album}
              <button class="btn small primary" onclick={() => get(i)}><Icon name="download" size={14} /> Download</button>
            {:else if !i.looked}
              <span class="muted small">Looking…</span>
            {:else}
              <span class="muted small" title="Not in the music catalog. Try Search with All of YouTube.">Not found</span>
            {/if}
          </div>
        </li>
      {:else}
        <li class="none">Everything you've been playing is already here.</li>
      {/each}
    </ul>
  {:else if !checking}
    <p class="muted intro">
      Pick what to compare and press Check. Songs you played on your phone or another computer count too, as long as they were
      scrobbled to Last.fm.
    </p>
  {/if}
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 18px;
  }
  .chips {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .chips button {
    height: 32px;
    padding: 0 14px;
    border-radius: var(--r-pill);
    font-size: 13px;
    font-weight: 600;
    color: var(--ink-2);
    border: 1px solid var(--line);
    background: var(--well);
    transition:
      color var(--t-fast),
      background var(--t-fast),
      border-color var(--t-fast);
  }
  .chips button.on {
    color: var(--accent);
    border-color: rgb(var(--accent-rgb) / 0.45);
    background: rgb(var(--accent-rgb) / 0.1);
  }
  .period {
    width: auto;
    height: 32px;
    border-radius: var(--r-pill);
    font-size: 13px;
  }
  .period option {
    background: var(--night-2);
  }
  .summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    padding: 16px 20px;
    margin-bottom: 14px;
    border-radius: var(--r-panel);
    background: rgb(var(--ink-rgb) / 0.04);
    border: 1px solid var(--line);
  }
  .nums {
    display: flex;
    gap: 28px;
  }
  .nums div {
    display: flex;
    flex-direction: column;
  }
  .nums strong {
    font: 700 26px var(--font-display);
    font-variant-numeric: tabular-nums;
  }
  .nums span {
    font-size: 12px;
    color: var(--ink-3);
  }
  .acts {
    display: flex;
    gap: 14px;
    align-items: center;
  }
  .mini {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 13px;
    color: var(--ink-2);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    max-width: 1000px;
  }
  .rows li {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) auto 30px 130px;
    gap: 14px;
    align-items: center;
    padding: 6px 10px;
    border-radius: 10px;
  }
  .rows li:hover {
    background: rgb(var(--ink-rgb) / 0.05);
  }
  .rows li.have {
    opacity: 0.65;
  }
  .rows li.none {
    display: block;
    color: var(--ink-2);
    padding: 20px 10px;
  }
  .txt {
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
    color: var(--ink-2);
  }
  .tag {
    font-size: 11px;
    font-weight: 700;
    padding: 1px 7px;
    margin-right: 8px;
    border-radius: 6px;
    vertical-align: 1px;
    color: var(--on-accent);
    background: var(--accent);
  }
  .why {
    font-size: 12px;
    color: var(--ink-3);
    white-space: nowrap;
  }
  .state {
    display: flex;
    justify-content: flex-end;
  }
  .btn.small {
    height: 30px;
    padding: 0 12px;
    font-size: 13px;
  }
  .btn.done {
    color: var(--accent);
  }
  .small {
    font-size: 13px;
  }
  .intro {
    max-width: 62ch;
  }
</style>
