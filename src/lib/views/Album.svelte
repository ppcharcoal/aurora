<script lang="ts">
  import { bytes, totalTime } from "../format";
  import { addToPlaylistItems } from "../menus";
  import { player } from "../player.svelte";
  import type { Album } from "../types";
  import { ui } from "../ui.svelte";
  import { isAndroid } from "../platform";
  import Artwork from "../components/Artwork.svelte";
  import Icon from "../components/Icon.svelte";
  import TrackList from "../components/TrackList.svelte";
  import ArtistInfo from "../components/ArtistInfo.svelte";
  import { lastfm } from "../lastfm.svelte";

  let { album }: { album: Album } = $props();
  const total = $derived(album.tracks.reduce((s, t) => s + t.durationMs, 0));
  const size = $derived(album.tracks.reduce((s, t) => s + (t.size ?? 0), 0));
</script>

<div class="page">
  <header class="hero">
    <Artwork src={album.art} size={208} radius="12px" eager />
    <div class="info">
      <div class="kind">{album.subtitle}</div>
      <h1 class:long={album.name.length > 28}>{album.name}</h1>
      <p class="muted">{album.tracks.length} {album.tracks.length === 1 ? "song" : "songs"}, {totalTime(total)}{size ? `, ${bytes(size)}` : ""}</p>
      <div class="actions">
        <button class="btn primary big" onclick={() => player.playList(album.tracks, 0)}><Icon name="play" size={16} /> Play</button>
        <button class="btn" onclick={() => player.shuffleAll(album.tracks)}><Icon name="shuffle" size={16} /> Shuffle</button>
        {#if lastfm.hasKey}
          <button class="btn" onclick={() => lastfm.startRadio(album.tracks[0])} disabled={lastfm.busy === "radio"}><Icon name="radio" size={16} /> Radio</button>
        {/if}
        <button class="btn" onclick={(e) => ui.openMenu(e, addToPlaylistItems(album.tracks.map((t) => t.id)))}>
          <Icon name="playlistAdd" size={16} /> Add to playlist
        </button>
        {#if !isAndroid && album.tracks.length > 1}
          <button class="btn" onclick={() => (ui.transitionList = { title: album.name, tracks: album.tracks })} title="Transitions between the songs">
            <Icon name="next" size={16} /> Transitions
          </button>
        {/if}
      </div>
    </div>
  </header>
  <TrackList tracks={album.tracks} showAlbum={false} />
  {#if lastfm.hasKey && lastfm.cfg.artistInfo && album.tracks[0]}
    <ArtistInfo artist={album.subtitle.split(",")[0] || album.tracks[0].artist} album={album.name} />
  {/if}
</div>

<style>
  .hero {
    display: flex;
    align-items: flex-end;
    gap: 28px;
    margin-bottom: 28px;
  }
  .hero :global(.art) {
    box-shadow: var(--shadow);
  }
  .info {
    min-width: 0;
  }
  .kind {
    color: var(--ink-2);
    font-size: 13px;
  }
  h1 {
    font-size: 64px;
    font-variation-settings: "wdth" 78;
    margin: 6px 0 8px;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  h1.long {
    font-size: 44px;
  }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 18px;
  }
  .big {
    height: 44px;
    padding: 0 24px;
  }

  /* Phone: cover on top, title and buttons centred under it. */
  :global(html[data-phone]) .hero {
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 14px;
    margin-bottom: 16px;
  }
  :global(html[data-phone]) .info {
    width: 100%;
  }
  :global(html[data-phone]) h1 {
    font-size: 34px;
    overflow-wrap: break-word;
  }
  :global(html[data-phone]) h1.long {
    font-size: 26px;
  }
  :global(html[data-phone]) .actions {
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin-top: 12px;
  }
</style>
