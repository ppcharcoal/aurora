<script lang="ts">
  import { downloads } from "../downloads.svelte";
  import { profiles } from "../profiles.svelte";
  import { lastfm } from "../lastfm.svelte";
  import type { CatalogTrack } from "../types";
  import CatalogCard from "../components/CatalogCard.svelte";
  import { player } from "../player.svelte";
  import { playlists } from "../playlists.svelte";
  import { library } from "../sources/local.svelte";
  import { tools } from "../tools.svelte";
  import { ui } from "../ui.svelte";
  import Artwork from "../components/Artwork.svelte";
  import CoverCard from "../components/CoverCard.svelte";
  import Icon from "../components/Icon.svelte";
  import Mosaic from "../components/Mosaic.svelte";

  const fresh = $derived(!library.tracks.length);

  // Discover: songs by artists similar to what you play (needs a Last.fm key).
  let discover = $state.raw<CatalogTrack[]>([]);
  let discoverState = $state<"idle" | "loading" | "error">("idle");
  $effect(() => {
    if (!lastfm.hasKey || !lastfm.cfg.discover) return;
    discoverState = "loading";
    lastfm
      .discover()
      .then((d) => {
        discover = d.filter((t) => !downloads.trackFor(t.id, t)).slice(0, 14);
        discoverState = "idle";
      })
      .catch(() => (discoverState = "error"));
  });
  let q = $state("");

  function search(e: SubmitEvent) {
    e.preventDefault();
    if (q.trim()) ui.go({ name: "search", q: q.trim() });
  }
</script>

<div class="page">
  <h1 class="hello">Hello, {profiles.active?.name ?? "there"}</h1>

  <form class="find" onsubmit={search}>
    <Icon name="search" size={20} />
    <input bind:value={q} placeholder={ui.phone ? "Search songs, albums…" : "What do you want to listen to?"} spellcheck="false" />
    <button class="btn primary" type="submit" disabled={!q.trim()}>Search</button>
  </form>

  {#if fresh}
    <div class="start">
      <button class="src" onclick={() => ui.go({ name: "search" })}>
        <Icon name="download" size={24} />
        <strong>Download from YouTube</strong>
        <span>Search, download as MP3 with cover art, and it's in your library.{tools.status && !tools.status.ready ? " A one-time setup installs the tools." : ""}</span>
      </button>
      <button class="src" onclick={() => ui.go({ name: "library" })}>
        <Icon name="folder" size={24} />
        <strong>Add music you already have</strong>
        <span>Point Aurora at a folder of MP3, FLAC, M4A or OGG files.</span>
      </button>
    </div>
  {/if}

  {#if lastfm.hasKey && lastfm.cfg.discover && (discover.length || discoverState === "loading")}
    <h2 class="section-title disc"><Icon name="sparkle" size={18} /> Discover</h2>
    {#if discoverState === "loading" && !discover.length}
      <div class="row">{#each Array(6) as _}<div class="skel"></div>{/each}</div>
    {:else}
      <div class="row">
        {#each discover as t (t.id)}<CatalogCard {t} />{/each}
      </div>
    {/if}
  {/if}

  {#if player.recent.length}
    <h2 class="section-title">Played recently</h2>
    <div class="recent">
      {#each player.recent.slice(0, 8) as t, i (t.key)}
        <button class="chip" onclick={() => player.playList(player.recent, i)}>
          <Artwork src={t.art} size={56} radius="8px 0 0 8px" />
          <span class="ct">
            <span class="tt">{t.title}</span>
            <span class="ta">{t.artist}</span>
          </span>
        </button>
      {/each}
    </div>
  {/if}

  {#if playlists.list.length}
    <h2 class="section-title">Your playlists</h2>
    <div class="row">
      {#each playlists.list as p (p.id)}
        <div class="pcard">
          <button class="hit" onclick={() => ui.go({ name: "playlist", id: p.id })} aria-label={`Open ${p.name}`}></button>
          <div class="cov">
            <Mosaic covers={playlists.covers(p)} />
            {#if p.trackIds.length}
              <button class="play" onclick={() => player.playList(playlists.tracks(p), 0)} aria-label={`Play ${p.name}`}><Icon name="play" size={18} /></button>
            {/if}
          </div>
          <div class="t">{p.name}</div>
          <div class="s">{p.trackIds.length} {p.trackIds.length === 1 ? "song" : "songs"}</div>
        </div>
      {/each}
    </div>
  {/if}

  {#if library.albums.length}
    <h2 class="section-title"><button class="link" onclick={() => ui.go({ name: "library" })}>Albums</button></h2>
    <div class="row">
      {#each library.albums.slice(0, 14) as a (a.id)}
        <CoverCard title={a.name} subtitle={a.subtitle} art={a.art} onopen={() => ui.go({ name: "album", album: a })} onplay={() => player.playList(a.tracks, 0)} />
      {/each}
    </div>
  {/if}

  {#if downloads.active}
    <button class="dlnote" onclick={() => ui.go({ name: "downloads" })}>
      <Icon name="download" size={16} /> {downloads.active} downloading — view progress
    </button>
  {/if}
</div>

<style>
  .hello {
    font-size: clamp(48px, 7vw, 88px);
    font-variation-settings: "wdth" 75;
    letter-spacing: -0.035em;
    line-height: 0.95;
    margin: 12px 0 22px;
    background: linear-gradient(100deg, var(--ink) 30%, rgb(var(--accent-rgb)) 90%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .find {
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: 640px;
    height: 54px;
    padding: 0 8px 0 18px;
    border-radius: var(--r-pill);
    background: var(--well);
    border: 1px solid var(--line);
    color: var(--ink-3);
    transition: border-color var(--t-fast);
  }
  .find:focus-within {
    border-color: rgb(var(--accent-rgb) / 0.6);
    color: var(--ink);
  }
  .find input {
    flex: 1;
    min-width: 0;
    font-size: 16px;
    background: none;
    border: 0;
    outline: none;
  }
  .find input::placeholder {
    color: var(--ink-3);
  }
  .start {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
    margin-top: 26px;
    max-width: 760px;
  }
  .src {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding: 20px;
    text-align: left;
    border-radius: var(--r-panel);
    background: rgb(var(--ink-rgb) / 0.04);
    border: 1px solid var(--line);
    transition:
      transform var(--t-med) var(--ease-out),
      border-color var(--t-fast);
  }
  .src :global(svg) {
    color: var(--accent);
  }
  .src:hover {
    transform: translateY(-3px);
    border-color: rgb(var(--accent-rgb) / 0.4);
  }
  .src strong {
    font-size: 16px;
  }
  .src span {
    color: var(--ink-2);
    font-size: 13px;
  }
  .recent {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr));
    gap: 10px;
  }
  .chip {
    display: flex;
    align-items: center;
    gap: 14px;
    height: 56px;
    border-radius: 8px;
    background: rgb(var(--ink-rgb) / 0.06);
    text-align: left;
    overflow: hidden;
    transition: background var(--t-fast);
  }
  .chip:hover {
    background: rgb(var(--ink-rgb) / 0.12);
  }
  .ct {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding-right: 12px;
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
    font-size: 12px;
    color: var(--ink-2);
  }
  .row {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 172px;
    gap: 20px;
    overflow-x: auto;
    padding: 10px;
    margin: -10px;
    scroll-snap-type: x proximity;
  }
  .row > :global(*) {
    scroll-snap-align: start;
  }
  .pcard {
    position: relative;
    padding: 10px;
    margin: -10px;
    border-radius: 14px;
    min-width: 0;
    transition: background var(--t-fast);
  }
  .pcard:hover {
    background: rgb(var(--ink-rgb) / 0.05);
  }
  .hit {
    position: absolute;
    inset: 0;
    z-index: 1;
    border-radius: 14px;
  }
  .cov {
    position: relative;
    margin-bottom: 10px;
  }
  .play {
    position: absolute;
    z-index: 2;
    right: 10px;
    bottom: 10px;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--on-accent);
    box-shadow: 0 8px 20px rgb(0 0 0 / 0.35);
    opacity: 0;
    transform: translateY(8px) scale(0.9);
    transition:
      opacity var(--t-fast),
      transform var(--t-med) var(--ease-spring);
  }
  .pcard:hover .play,
  .play:focus-visible {
    opacity: 1;
    transform: none;
  }
  .t {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .s {
    font-size: 13px;
    color: var(--ink-2);
  }
  .disc {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .disc :global(svg) {
    color: var(--accent);
  }
  .skel {
    aspect-ratio: 1;
    border-radius: 10px;
    background: rgb(var(--ink-rgb) / 0.06);
    animation: pulse 1.3s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.45;
    }
  }
  .link:hover {
    text-decoration: underline;
    text-underline-offset: 4px;
  }
  .dlnote {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: 28px;
    color: var(--accent);
    font-weight: 600;
  }
</style>
