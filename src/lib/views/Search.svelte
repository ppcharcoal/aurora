<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { cached } from "../cache";
  import { downloads } from "../downloads.svelte";
  import { approx, time } from "../format";
  import { addToPlaylistItems, trackMenu } from "../menus";
  import { player } from "../player.svelte";
  import { library } from "../sources/local.svelte";
  import { tools } from "../tools.svelte";
  import type { AlbumResult, CatalogTrack, SearchResult, Track } from "../types";
  import { settings } from "../settings.svelte";
  import { ui } from "../ui.svelte";
  import { splitTitle, thumb, thumbFallback, views } from "../ytparse";
  import Artwork from "../components/Artwork.svelte";
  import Icon from "../components/Icon.svelte";
  import AlbumDialog from "../components/AlbumDialog.svelte";
  import PreviewButton from "../components/PreviewButton.svelte";
  import { previewSource } from "../preview.svelte";

  let { q = "" }: { q?: string } = $props();
  const query = $derived(q.trim());

  /* ------- your library: instant ------- */
  const local = $derived.by(() => {
    const s = query.toLowerCase();
    if (s.length < 2) return [] as Track[];
    const out: Track[] = [];
    for (const t of library.tracks) {
      if (t.title.toLowerCase().includes(s) || t.artist.toLowerCase().includes(s) || (t.album ?? "").toLowerCase().includes(s)) {
        out.push(t);
        if (out.length >= 6) break;
      }
    }
    return out;
  });

  /* ------- YouTube via yt-dlp: after a short pause in typing ------- */
  let results = $state.raw<SearchResult[]>([]);
  let loading = $state(false);
  let failed = $state<string | null>(null);
  let seq = 0;

  async function search(s: string) {
    const mine = ++seq;
    loading = true;
    failed = null;
    try {
      const where = site;
      const r = await cached(`${where}:${s.toLowerCase()}`, () => invoke<SearchResult[]>("yt_search", { query: s, limit: 24, site: where }));
      if (mine === seq) results = r.filter((x) => !x.live);
    } catch (e) {
      if (mine === seq) failed = String(e);
    } finally {
      if (mine === seq) loading = false;
    }
  }

  $effect(() => {
    const s = query;
    if (s.length < 2) {
      results = [];
      return;
    }
    if (verified || !tools.status?.ready || ui.searchMode !== "songs") return;
    site; // search again when switching between YouTube and SoundCloud
    const t = setTimeout(() => search(s), 650);
    return () => clearTimeout(t);
  });

  /* ------- "Music only": songs from the music catalog ------- */
  const verified = $derived(settings.value.searchSource === "catalog");
  const site = $derived(settings.value.searchSource === "soundcloud" ? "soundcloud" : "youtube");
  let songs = $state.raw<CatalogTrack[]>([]);
  let songsLoading = $state(false);
  let songsFailed = $state<string | null>(null);
  let songsFor = $state("");
  let sseq = 0;

  async function searchSongs(s: string) {
    const mine = ++sseq;
    songsLoading = true;
    songsFailed = null;
    try {
      const r = await cached(`cat:${s.toLowerCase()}`, () => invoke<CatalogTrack[]>("catalog_search_tracks", { query: s }));
      if (mine === sseq) {
        songs = r;
        songsFor = s;
      }
    } catch (e) {
      if (mine === sseq) songsFailed = String(e);
    } finally {
      if (mine === sseq) songsLoading = false;
    }
  }

  $effect(() => {
    const s = query;
    if (s.length < 2 || !verified || ui.searchMode !== "songs" || s === songsFor) return;
    const t = setTimeout(() => searchSongs(s), 450);
    return () => clearTimeout(t);
  });

  function catalogMenu(e: MouseEvent, t: CatalogTrack) {
    ui.openMenu(e, addToPlaylistItems([], (pid) => downloads.enqueueCatalog(t, pid)));
  }

  /* ------- albums: YouTube Music, each one looked up for its track list ------- */
  let albums = $state.raw<AlbumResult[]>([]);
  let albumsLoading = $state(false);
  let albumsFailed = $state<string | null>(null);
  let albumsFor = $state("");
  let aseq = 0;
  let openAlbum = $state<AlbumResult | null>(null);

  async function searchAlbums(s: string) {
    const mine = ++aseq;
    albumsLoading = true;
    albumsFailed = null;
    try {
      const key = `${verified ? "cata" : "yta"}:${s.toLowerCase()}`;
      const cmd = verified ? "catalog_search_albums" : "yt_search_albums";
      const r = await cached(key, () => invoke<AlbumResult[]>(cmd, { query: s }));
      if (mine === aseq) {
        albums = r;
        albumsFor = `${verified}:${s}`;
      }
    } catch (e) {
      if (mine === aseq) albumsFailed = String(e);
    } finally {
      if (mine === aseq) albumsLoading = false;
    }
  }

  $effect(() => {
    const s = query;
    if (s.length < 2 || (!verified && !tools.status?.ready) || ui.searchMode !== "albums" || `${verified}:${s}` === albumsFor) return;
    const t = setTimeout(() => searchAlbums(s), verified ? 450 : 900);
    return () => clearTimeout(t);
  });

  const albumTracks = (a: AlbumResult) =>
    a.tracks.map((t) => downloads.trackFor(t.id, { artist: t.artist ?? a.artist, title: t.title, durationMs: t.durationMs })).filter((t): t is Track => !!t);

  function download(r: SearchResult) {
    downloads.enqueue(r);
  }

  function playlistMenu(e: MouseEvent, r: SearchResult) {
    ui.openMenu(e, addToPlaylistItems([], (pid) => downloads.enqueue(r, pid)));
  }

  const playDownloaded = (t: Track) => player.playList([t], 0);
</script>

<div class="page">
  {#if query.length < 2}
    <h1 class="page-title">Search</h1>
    <p class="muted hint">
      Type in the search bar above. With <strong>Music only</strong> on, results come from a music catalog, so you only see real
      songs and albums. Download one and Aurora finds the best matching upload, saves it as a tagged MP3 with its cover, and it's
      ready to play.
    </p>
  {/if}

  {#if tools.status && !tools.status.ready}
    <div class="setup">
      <Icon name="download" size={22} />
      <div class="txt">
        <strong>Set up downloads</strong>
        <span class="muted">
          {#if tools.installing && tools.progress}
            Downloading {tools.progress.step}… {tools.progress.total ? Math.round((tools.progress.done / tools.progress.total) * 100) + "%" : ""}
          {:else}
            Aurora needs yt-dlp and FFmpeg (about 150 MB, one time) to search and convert music.
          {/if}
        </span>
        {#if tools.installing && tools.progress?.total}
          <div class="rail"><div class="fill" style:transform={`scaleX(${tools.progress.done / tools.progress.total})`}></div></div>
        {/if}
      </div>
      <button class="btn primary" onclick={() => tools.install()} disabled={tools.installing || !tools.status.canInstall}>
        {tools.installing ? "Installing…" : "Install"}
      </button>
    </div>
  {/if}

  {#if query.length >= 2}
    <h1 class="page-title">Results for “{query}”</h1>

    {#if local.length}
      <h2 class="section-title">In your library</h2>
      <div class="local">
        {#each local as t (t.key)}
          <div class="lrow" role="listitem" oncontextmenu={(e) => ui.openMenu(e, trackMenu(t))}>
            <button class="hit" onclick={() => player.playList(local, local.indexOf(t))} aria-label={`Play ${t.title}`}></button>
            <Artwork src={t.art} size={44} radius="6px" />
            <div class="txt"><div class="t">{t.title}</div><div class="a">{t.artist}</div></div>
            <span class="d">{time(t.durationMs)}</span>
          </div>
        {/each}
      </div>
    {/if}

    <div class="modebar">
      <h2 class="section-title yt">
        {#if verified}<Icon name="check" size={18} stroke={2.4} /> Music catalog{:else if site === "soundcloud"}<Icon name="soundcloud" size={18} /> SoundCloud{:else}<Icon name="youtube" size={18} /> YouTube{/if}
      </h2>
      <div class="seg" role="tablist">
        <button role="tab" aria-selected={ui.searchMode === "songs"} class:on={ui.searchMode === "songs"} onclick={() => (ui.searchMode = "songs")}>Songs</button>
        <button role="tab" aria-selected={ui.searchMode === "albums"} class:on={ui.searchMode === "albums"} onclick={() => (ui.searchMode = "albums")}>Albums</button>
        <span class="ink" style:transform={ui.searchMode === "songs" ? "translateX(0)" : "translateX(100%)"}></span>
      </div>
    </div>

    {#if ui.searchMode === "albums" && site === "soundcloud" && !verified}
      <div class="empty">
        <h2>Albums come from the catalog or YouTube</h2>
        <p>SoundCloud doesn't have proper albums. Switch to Music only or YouTube above to search albums, or search SoundCloud for songs.</p>
        <button class="btn" onclick={() => settings.set("searchSource", "catalog")}><Icon name="check" size={15} /> Use Music only</button>
      </div>
    {:else if ui.searchMode === "albums"}
      {#if albumsFailed}
        <div class="empty"><h2>Album search didn't work</h2><p>{albumsFailed}</p><button class="btn" onclick={() => searchAlbums(query)}><Icon name="refresh" size={15} /> Try again</button></div>
      {:else if albumsLoading && !albums.length}
        <p class="muted">{verified ? "Looking up albums…" : "Looking up albums and their track lists… this takes a few seconds."}</p>
        <div class="grid-al">
          {#each Array(6) as _, i}<div class="sk sq" style:animation-delay={`${i * 70}ms`}></div>{/each}
        </div>
      {:else if !albumsLoading && !albums.length && albumsFor === `${verified}:${query}`}
        <p class="muted">No albums found for “{query}”. Try the artist's name, or artist and album together.</p>
      {/if}
      <div class="grid-al" class:stale={albumsLoading}>
        {#each albums as a, i (a.id)}
          {@const dl = downloads.albumStatus(a)}
          {@const have = downloads.albumHave(a)}
          <article class="al" style:animation-delay={`${Math.min(i, 12) * 40}ms`}>
            <button class="cover" onclick={() => (openAlbum = a)} aria-label={`Show ${a.title}`}>
              {#if a.thumb}<img src={a.thumb} alt="" loading="lazy" decoding="async" draggable="false" onerror={thumbFallback} onload={thumbFallback} />{/if}
              {#if dl && (dl.status === "downloading" || dl.status === "queued")}
                <div class="prog"><div class="pfill" style:transform={`scaleX(${dl.percent / 100})`}></div></div>
              {/if}
            </button>
            <div class="meta">
              <div class="t" title={a.title}>{a.title}</div>
              <div class="a">{a.artist} — {a.tracks.length} {a.tracks.length === 1 ? "song" : "songs"}{a.year ? `, ${a.year}` : ""}</div>
              <div class="sz">{approx(a.tracks.reduce((s, x) => s + x.durationMs, 0), settings.value.quality)}</div>
            </div>
            <div class="acts">
              {#if dl?.status === "queued"}
                <button class="btn small" onclick={() => downloads.cancel(dl.id)}>Queued — cancel</button>
              {:else if dl?.status === "downloading"}
                <button class="btn small" onclick={() => downloads.cancel(dl.id)}>{(dl.completed ?? 0) + 1} of {a.tracks.length} — cancel</button>
              {:else if have === a.tracks.length}
                <button class="btn small done" onclick={() => player.playList(albumTracks(a), 0)}><Icon name="play" size={13} /> Play</button>
              {:else}
                <button class="btn small primary" onclick={() => downloads.enqueueAlbum(a)}>
                  <Icon name="download" size={14} /> {have ? `${ui.phone ? "Get" : "Download"} ${a.tracks.length - have} more` : ui.phone ? "Download" : "Download album"}
                </button>
              {/if}
              <button class="btn small icon-only" onclick={() => (openAlbum = a)} aria-label="Show tracks" title="Show tracks"><Icon name="queue" size={16} /></button>
            </div>
          </article>
        {/each}
      </div>
    {:else if verified}
      {#if songsFailed}
        <div class="empty">
          <h2>The music catalog didn't answer</h2>
          <p>{songsFailed}</p>
          <div class="row">
            <button class="btn" onclick={() => searchSongs(query)}><Icon name="refresh" size={15} /> Try again</button>
            <button class="btn" onclick={() => settings.set("searchSource", "youtube")}><Icon name="youtube" size={15} /> Search YouTube instead</button>
          </div>
        </div>
      {:else if songsLoading && !songs.length}
        <div class="grid-al">
          {#each Array(8) as _, i}<div class="sk sq" style:animation-delay={`${i * 70}ms`}></div>{/each}
        </div>
      {:else if !songsLoading && !songs.length && songsFor === query}
        <p class="muted">No songs called “{query}” in the catalog. Try other words, or switch to All of YouTube for remixes, covers and live versions.</p>
      {/if}
      <div class="grid-al" class:stale={songsLoading}>
        {#each songs as t, i (t.id)}
          {@const dl = downloads.status(t.id)}
          {@const have = downloads.trackFor(t.id, t)}
          <article class="al" style:animation-delay={`${Math.min(i, 12) * 35}ms`}>
            <div class="cover song">
              {#if t.cover}<img src={t.cover} alt="" loading="lazy" decoding="async" draggable="false" />{/if}
              {#if t.durationMs}<span class="dur">{time(t.durationMs)}</span>{/if}
              {#if dl && (dl.status === "downloading" || dl.status === "converting")}
                <div class="prog"><div class="pfill" style:transform={`scaleX(${dl.status === "converting" ? 1 : dl.percent / 100})`}></div></div>
              {/if}
            </div>
            <div class="meta">
              <div class="t" title={t.title}>{t.title}{#if t.explicit}<span class="ex" title="Explicit">E</span>{/if}</div>
              <div class="a">{t.artist}{t.album ? ` — ${t.album}` : ""}</div>
              <div class="sz">{approx(t.durationMs, settings.value.quality)}</div>
            </div>
            <div class="acts">
              {#if !have && previewSource({ preview: t.preview })}<PreviewButton key={t.id} src={previewSource({ preview: t.preview })!} />{/if}
              {#if have}
                <button class="btn small done" onclick={() => playDownloaded(have)}><Icon name="play" size={13} /> Play</button>
              {:else if dl?.status === "queued"}
                <button class="btn small" onclick={() => downloads.cancel(t.id)}>Queued — cancel</button>
              {:else if dl?.status === "downloading" && dl.current}
                <button class="btn small" onclick={() => downloads.cancel(t.id)}>Finding source — cancel</button>
              {:else if dl?.status === "downloading"}
                <button class="btn small" onclick={() => downloads.cancel(t.id)}>{Math.round(dl.percent)}% — cancel</button>
              {:else if dl?.status === "converting"}
                <button class="btn small" disabled>Converting…</button>
              {:else}
                <button class="btn small primary" onclick={() => downloads.enqueueCatalog(t)}><Icon name="download" size={14} /> Download</button>
              {/if}
              <button class="btn small icon-only pl" onclick={(e) => catalogMenu(e, t)} aria-label="Download to a playlist" title="Download to a playlist">
                <Icon name="playlistAdd" size={16} />
              </button>
            </div>
          </article>
        {/each}
      </div>
    {:else}
    {#if failed}
      <div class="empty"><h2>Search didn't work</h2><p>{failed}</p><button class="btn" onclick={() => search(query)}><Icon name="refresh" size={15} /> Try again</button></div>
    {:else if loading && !results.length}
      <div class="grid-yt">
        {#each Array(8) as _, i}<div class="sk" style:animation-delay={`${i * 70}ms`}></div>{/each}
      </div>
    {:else if !loading && !results.length && tools.status?.ready}
      <p class="muted">No videos found for “{query}”.</p>
    {/if}

    <div class="grid-yt" class:stale={loading}>
      {#each results as r, i (r.id)}
        {@const nice = splitTitle(r.title, r.channel)}
        {@const dl = downloads.status(r.id)}
        {@const have = downloads.trackFor(r.id, { ...nice, durationMs: r.durationMs })}
        <article class="res" style:animation-delay={`${Math.min(i, 12) * 35}ms`}>
          <div class="thumb">
            <img src={r.thumb ?? thumb(r.id)} alt="" loading="lazy" decoding="async" draggable="false" class:sq={r.site === "soundcloud"} />
            {#if r.durationMs}<span class="dur">{time(r.durationMs)}</span>{/if}
            {#if dl && (dl.status === "downloading" || dl.status === "converting")}
              <div class="prog"><div class="pfill" style:transform={`scaleX(${dl.status === "converting" ? 1 : dl.percent / 100})`}></div></div>
            {/if}
          </div>
          <div class="meta">
            <div class="t" title={r.title}>{nice.title}</div>
            <div class="a">{nice.artist}{r.views ? ` — ${views(r.views)}` : ""}</div>
            <div class="sz">
              {#if r.previewOnly}<span class="clip" title="SoundCloud Go+ track: only a 30-second clip can be downloaded">30-second clip only</span>{:else}{approx(r.durationMs, settings.value.quality)}{/if}
            </div>
          </div>
          <div class="acts">
            {#if !have}<PreviewButton key={r.id} src={previewSource({ id: r.id, streamable: true })!} />{/if}
            {#if have}
              <button class="btn small done" onclick={() => playDownloaded(have)}><Icon name="play" size={13} /> Play</button>
            {:else if dl?.status === "queued"}
              <button class="btn small" onclick={() => downloads.cancel(r.id)}>Queued — cancel</button>
            {:else if dl?.status === "downloading"}
              <button class="btn small" onclick={() => downloads.cancel(r.id)}>{Math.round(dl.percent)}% — cancel</button>
            {:else if dl?.status === "converting"}
              <button class="btn small" disabled>Converting…</button>
            {:else}
              <button class="btn small primary" onclick={() => download(r)}><Icon name="download" size={14} /> Download</button>
            {/if}
            <button class="btn small icon-only pl" onclick={(e) => playlistMenu(e, r)} aria-label="Download to a playlist" title="Download to a playlist">
              <Icon name="playlistAdd" size={16} />
            </button>
          </div>
        </article>
      {/each}
    </div>
    {/if}
  {/if}
</div>

{#if openAlbum}
  <AlbumDialog album={openAlbum} onclose={() => (openAlbum = null)} />
{/if}

<style>
  .hint {
    max-width: 60ch;
  }
  .setup {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 16px 18px;
    margin-bottom: 24px;
    border-radius: var(--r-panel);
    background: rgb(var(--accent-rgb) / 0.08);
    border: 1px solid rgb(var(--accent-rgb) / 0.25);
    color: var(--accent);
  }
  .setup .txt {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--ink);
  }
  .rail {
    margin-top: 6px;
    height: 4px;
    border-radius: 4px;
    background: rgb(var(--ink-rgb) / 0.1);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transform-origin: left;
    transition: transform 300ms linear;
  }
  .section-title.yt {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .yt :global(svg) {
    color: #ff4e45;
  }
  .local {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr));
    gap: 4px 20px;
  }
  .lrow {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px;
    border-radius: 10px;
    transition: background var(--t-fast);
  }
  .lrow:hover {
    background: rgb(var(--ink-rgb) / 0.06);
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
  .t,
  .a {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t {
    font-weight: 600;
  }
  .a {
    font-size: 13px;
    color: var(--ink-2);
  }
  .d {
    font-size: 13px;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }
  .grid-yt {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(230px, 100%), 1fr));
    gap: 22px 18px;
    transition: opacity var(--t-med);
  }
  .modebar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin: 32px 0 14px;
  }
  .modebar .section-title {
    margin: 0;
  }
  .seg {
    position: relative;
    display: grid;
    grid-template-columns: 1fr 1fr;
    padding: 4px;
    border-radius: var(--r-pill);
    background: var(--well);
  }
  .seg button {
    position: relative;
    z-index: 1;
    height: 30px;
    padding: 0 18px;
    border-radius: var(--r-pill);
    font-weight: 600;
    color: var(--ink-2);
    transition: color var(--t-fast);
  }
  .seg button.on {
    color: var(--night);
  }
  .seg .ink {
    position: absolute;
    top: 4px;
    bottom: 4px;
    left: 4px;
    width: calc(50% - 4px);
    border-radius: var(--r-pill);
    background: var(--ink);
    transition: transform var(--t-med) var(--ease-spring);
  }
  .grid-al {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 24px 18px;
    transition: opacity var(--t-med);
  }
  .grid-al.stale {
    opacity: 0.55;
  }
  .al {
    min-width: 0;
    animation: rise var(--t-med) var(--ease-out) both;
  }
  .al .cover {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 1;
    border-radius: 10px;
    overflow: hidden;
    background: var(--night-3);
    box-shadow: 0 12px 30px rgb(0 0 0 / 0.3);
  }
  .al .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform var(--t-med) var(--ease-out);
  }
  .al:hover .cover img {
    transform: scale(1.04);
  }
  .sk.sq {
    aspect-ratio: 1;
  }
  .cover.song {
    position: relative;
    aspect-ratio: 1;
    border-radius: 10px;
    overflow: hidden;
    background: var(--night-3);
    box-shadow: 0 12px 30px rgb(0 0 0 / 0.25);
  }
  .cover.song img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform var(--t-med) var(--ease-out);
  }
  .al:hover .cover.song img {
    transform: scale(1.04);
  }
  .sz {
    font-size: 12px;
    color: var(--ink-3);
    margin-top: 2px;
  }
  .clip {
    color: var(--warn);
  }
  .thumb img.sq {
    object-fit: contain;
    background: var(--night-3);
  }
  .ex {
    display: inline-grid;
    place-items: center;
    width: 16px;
    height: 16px;
    margin-left: 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    vertical-align: 1px;
    color: var(--night);
    background: var(--ink-3);
  }
  .row {
    display: flex;
    gap: 10px;
  }
  .grid-yt.stale {
    opacity: 0.55;
  }
  .res {
    min-width: 0;
    animation: rise var(--t-med) var(--ease-out) both;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
  .thumb {
    position: relative;
    aspect-ratio: 16 / 9;
    border-radius: 10px;
    overflow: hidden;
    background: var(--night-3);
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform var(--t-med) var(--ease-out);
  }
  .res:hover .thumb img {
    transform: scale(1.04);
  }
  .dur {
    position: absolute;
    right: 6px;
    bottom: 6px;
    padding: 1px 6px;
    border-radius: 5px;
    font-size: 12px;
    font-weight: 600;
    background: rgb(0 0 0 / 0.72);
    font-variant-numeric: tabular-nums;
  }
  .prog {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 4px;
    background: rgb(0 0 0 / 0.5);
  }
  .pfill {
    height: 100%;
    background: var(--accent);
    transform-origin: left;
    transition: transform 300ms linear;
  }
  .meta {
    margin: 10px 0 10px;
  }
  .acts {
    display: flex;
    gap: 8px;
  }
  .btn.small {
    height: 32px;
    padding: 0 14px;
    font-size: 13px;
  }
  .btn.icon-only {
    width: 32px;
    padding: 0;
    justify-content: center;
  }
  .btn.done {
    color: var(--accent);
  }
  .sk {
    aspect-ratio: 16 / 9;
    border-radius: 10px;
    background: rgb(var(--ink-rgb) / 0.05);
    animation: pulse 1.3s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.45;
    }
  }

  /* Phone: two cards per row; the heading and its switch share one line. */
  :global(html[data-phone]) .grid-yt,
  :global(html[data-phone]) .grid-al {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px 12px;
  }
  :global(html[data-phone]) .modebar {
    margin: 24px 0 12px;
    gap: 10px;
  }
  :global(html[data-phone]) .modebar .section-title {
    font-size: 18px;
    white-space: nowrap;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  :global(html[data-phone]) .seg {
    flex: none;
  }
  :global(html[data-phone]) .seg button {
    padding: 0 12px;
  }

  /* Phone: preview + one wide main button per card. "Download to a playlist"
     is left out here (playlists still work from a song's menu once it's downloaded). */
  :global(html[data-phone]) .acts {
    gap: 6px;
    align-items: center;
    min-width: 0;
  }
  :global(html[data-phone]) .acts .pl {
    display: none;
  }
  :global(html[data-phone]) .acts > .btn:not(.icon-only) {
    flex: 1 1 0;
    min-width: 0;
    height: 36px;
    min-height: 36px;
    padding: 0 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  :global(html[data-phone]) .btn.icon-only {
    flex: none;
    width: 36px;
    height: 36px;
    min-height: 36px;
    border-radius: 50%;
  }
</style>
