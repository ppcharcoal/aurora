<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { onDestroy } from "svelte";
  import { downloads } from "../downloads.svelte";
  import { lastfm, type Friend, type FriendTrack } from "../lastfm.svelte";
  import { player } from "../player.svelte";
  import { previewSource } from "../preview.svelte";
  import { settings } from "../settings.svelte";
  import { ui } from "../ui.svelte";
  import Artwork from "../components/Artwork.svelte";
  import Icon from "../components/Icon.svelte";
  import PreviewButton from "../components/PreviewButton.svelte";

  let friends = $state<Friend[] | null>(null);
  let failed = $state<string | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;

  async function load() {
    try {
      friends = await lastfm.friends();
      failed = null;
    } catch (e) {
      failed = String(e);
    }
  }

  $effect(() => {
    if (!lastfm.connected) return;
    load();
    // Keep "listening now" fresh while this page is open.
    timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  });
  onDestroy(() => clearInterval(timer));

  function ago(ms?: number) {
    if (!ms) return "";
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 60) return `${Math.max(1, m)} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  /** Preview: the catalog clip, else stream the best YouTube match. */
  function src(t: FriendTrack) {
    if (t.catalog?.preview) return previewSource({ preview: t.catalog.preview })!;
    return async () => {
      const ids = await invoke<string[]>("yt_find_source", { artist: t.artist, title: t.title, durationMs: t.catalog?.durationMs ?? 0, site: "youtube" });
      return invoke<string>("yt_stream_url", { id: ids[0] });
    };
  }

  function get(t: FriendTrack) {
    if (t.catalog) downloads.enqueueCatalog(t.catalog);
    else {
      settings.set("searchSource", "youtube");
      ui.go({ name: "search", q: `${t.artist} ${t.title}` });
    }
  }
</script>

<div class="page">
  <div class="top">
    <h1 class="page-title">Friends</h1>
    {#if lastfm.connected}<button class="btn" onclick={load}><Icon name="refresh" size={15} /> Refresh</button>{/if}
  </div>

  {#if !lastfm.connected}
    <div class="empty">
      <h2>See what your friends are playing</h2>
      <p>Connect Last.fm, and the people you follow there show up here with what they're listening to right now. Preview any song and download it in one click.</p>
      <button class="btn primary" onclick={() => ui.go({ name: "profile" })}><Icon name="link" size={16} /> Set up Last.fm</button>
    </div>
  {:else if failed}
    <div class="empty"><h2>Couldn't load your friends</h2><p>{failed}</p><button class="btn" onclick={load}>Try again</button></div>
  {:else if friends === null}
    <div class="grid">{#each Array(4) as _}<div class="sk"></div>{/each}</div>
  {:else if !friends.length}
    <div class="empty">
      <h2>No friends with recent plays</h2>
      <p>Follow people on Last.fm (their profile → Follow) and their listening shows up here.</p>
      <button class="btn" onclick={() => openUrl("https://www.last.fm/user/" + lastfm.cfg.user + "/following")}><Icon name="link" size={15} /> Open Last.fm</button>
    </div>
  {:else}
    <div class="grid">
      {#each friends as f (f.name)}
        <article class="friend" class:live={f.tracks[0]?.nowPlaying}>
          <header>
            <span class="av">{#if f.image}<img src={f.image} alt="" />{:else}{f.name.charAt(0).toUpperCase()}{/if}</span>
            <div class="who">
              <button class="name" onclick={() => f.url && openUrl(f.url)}>{f.realname ?? f.name}</button>
              <span class="status">
                {#if f.tracks[0]?.nowPlaying}<span class="dot"></span> Listening now{:else}{ago(f.tracks[0]?.when)}{/if}
              </span>
            </div>
          </header>
          <ul>
            {#each f.tracks as t, i (t.artist + t.title + i)}
              {@const mine = lastfm.find(t.artist, t.title) ?? (t.catalog ? downloads.trackFor(t.catalog.id, t.catalog) : undefined)}
              {@const dl = t.catalog ? downloads.status(t.catalog.id) : undefined}
              <li class:first={i === 0}>
                <Artwork src={t.catalog?.cover ?? t.image} size={i === 0 ? 56 : 40} radius="6px" />
                <div class="txt">
                  <div class="tt">{t.title}</div>
                  <div class="ta">{t.artist}{i > 0 && t.when ? ` · ${ago(t.when)}` : ""}</div>
                </div>
                {#if mine}
                  <button class="btn small done" onclick={() => player.playList([mine], 0)}><Icon name="play" size={13} /> Play</button>
                {:else}
                  <PreviewButton key={`fr:${f.name}:${i}`} src={src(t)} />
                  {#if dl && (dl.status === "queued" || dl.status === "downloading" || dl.status === "converting")}
                    <span class="pct">{Math.round(dl.percent)}%</span>
                  {:else}
                    <button class="icon" onclick={() => get(t)} title={t.catalog ? "Download" : "Search on YouTube"} aria-label="Download">
                      <Icon name={t.catalog ? "download" : "search"} size={16} />
                    </button>
                  {/if}
                {/if}
              </li>
            {/each}
          </ul>
        </article>
      {/each}
    </div>
  {/if}
</div>

<style>
  .top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(360px, 100%), 1fr));
    gap: 16px;
  }
  .sk {
    height: 220px;
    border-radius: var(--r-panel);
    background: rgb(var(--ink-rgb) / 0.05);
    animation: pulse 1.3s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.45;
    }
  }
  .friend {
    padding: 16px;
    border-radius: var(--r-panel);
    background: rgb(var(--ink-rgb) / 0.04);
    border: 1px solid var(--line);
  }
  .friend.live {
    border-color: rgb(var(--accent-rgb) / 0.4);
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }
  .av {
    width: 40px;
    height: 40px;
    flex: none;
    border-radius: 50%;
    overflow: hidden;
    display: grid;
    place-items: center;
    font-weight: 700;
    color: var(--on-accent);
    background: linear-gradient(140deg, var(--violet), rgb(var(--accent-rgb)));
  }
  .av img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    font-weight: 700;
    text-align: left;
  }
  .name:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .status {
    font-size: 12px;
    color: var(--ink-3);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .live .status {
    color: var(--accent);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    animation: live 1.6s ease-in-out infinite;
  }
  @keyframes live {
    50% {
      box-shadow: 0 0 0 5px rgb(var(--accent-rgb) / 0.2);
    }
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px;
    border-radius: 10px;
  }
  li:hover {
    background: rgb(var(--ink-rgb) / 0.05);
  }
  li.first .tt {
    font-size: 15px;
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
    color: var(--ink-2);
  }
  .btn.small {
    height: 30px;
    padding: 0 12px;
    font-size: 13px;
  }
  .btn.done {
    color: var(--accent);
  }
  .icon {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--ink-2);
    background: var(--well);
  }
  .icon:hover {
    color: var(--ink);
  }
  .pct {
    width: 32px;
    font-size: 12px;
    color: var(--accent);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
</style>
