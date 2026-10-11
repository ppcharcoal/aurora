<script lang="ts">
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { player } from "../player.svelte";
  import { library } from "../sources/local.svelte";
  import { ui } from "../ui.svelte";
  import CoverCard from "../components/CoverCard.svelte";
  import Icon from "../components/Icon.svelte";
  import TrackList from "../components/TrackList.svelte";
  import Mosaic from "../components/Mosaic.svelte";
  import { playlists } from "../playlists.svelte";
  import { isAndroid } from "../platform";
  import PhoneMusic from "../components/PhoneMusic.svelte";

  // Open on Albums only when there are albums to show.
  let tab = $state<"songs" | "albums" | "playlists">(library.albums.length ? "albums" : "songs");
  const tabs = $derived<("albums" | "songs" | "playlists")[]>(ui.phone ? ["albums", "songs", "playlists"] : ["albums", "songs"]);
  let filter = $state("");

  const q = $derived(filter.trim().toLowerCase());
  const songs = $derived(
    q
      ? library.tracks.filter(
          (t) =>
            t.title.toLowerCase().includes(q) ||
            t.artist.toLowerCase().includes(q) ||
            (t.album ?? "").toLowerCase().includes(q),
        )
      : library.tracks,
  );
  const albums = $derived(
    q
      ? library.albums.filter((a) => a.name.toLowerCase().includes(q) || (a.subtitle ?? "").toLowerCase().includes(q))
      : library.albums,
  );

  async function addFolder() {
    const dir = await openDialog({ directory: true, multiple: false, title: "Choose a music folder" });
    if (typeof dir !== "string") return;
    try {
      await library.addFolder(dir);
      ui.toast(`Added ${dir}`, "success");
    } catch (e) {
      ui.error(e);
    }
  }
</script>

<div class="page">
  <div class="top">
    <h1 class="page-title">Library</h1>
    <div class="tools">
      <button class="btn" onclick={() => library.rescan().catch(ui.error)} disabled={library.scanning || !library.folders.length}>
        <Icon name="refresh" size={15} /> Rescan
      </button>
      {#if !isAndroid}
        <button class="btn primary" onclick={addFolder} disabled={library.scanning}>
          <Icon name="plus" size={15} /> Add folder
        </button>
      {/if}
    </div>
  </div>

  {#if !library.folders.length && isAndroid}
    <div class="empty">
      <h2>Nothing here yet</h2>
      <p>Songs and albums you download show up here, ready to play offline, on the lock screen and in Android Auto. Music that's already on your phone can come in too.</p>
      <div class="emptyrow">
        <button class="btn primary" onclick={() => ui.go({ name: "search" })}><Icon name="search" size={16} /> Find music</button>
      </div>
      <PhoneMusic />
    </div>
  {:else if !library.folders.length}
    <div class="empty">
      <h2>No folders yet</h2>
      <p>Songs you download land here automatically. You can also add folders of music you already have: MP3, FLAC, M4A, OGG, Opus and WAV, with embedded covers or cover.jpg files.</p>
      <button class="btn primary" onclick={addFolder}><Icon name="folder" size={16} /> Choose a folder</button>
    </div>
  {:else}
    <div class="bar">
      <div class="tabs" role="tablist">
        {#each tabs as k (k)}
          <button role="tab" aria-selected={tab === k} class:on={tab === k} onclick={() => (tab = k)}>
            {k === "albums" ? "Albums" : k === "songs" ? "Songs" : "Playlists"}
            <small>{k === "albums" ? library.albums.length : k === "songs" ? library.tracks.length : playlists.list.length}</small>
          </button>
        {/each}
        <span class="ink" style:width={`calc(${100 / tabs.length}% - ${8 / tabs.length}px)`} style:transform={`translateX(${Math.max(0, tabs.indexOf(tab)) * 100}%)`}></span>
      </div>
      <input class="field filter" placeholder="Filter" bind:value={filter} spellcheck="false" />
    </div>

    {#if tab === "albums" && !library.albums.length}
      <div class="empty">
        <h2>No albums yet</h2>
        <p>Download a whole album from Search → Albums and it shows up here. Songs downloaded on their own are in the Songs tab.</p>
        <button class="btn primary" onclick={() => { ui.searchMode = "albums"; ui.go({ name: "search" }); }}><Icon name="search" size={16} /> Find albums</button>
      </div>
    {:else if tab === "albums"}
      <div class="grid">
        {#each albums as a (a.id)}
          <CoverCard
            title={a.name}
            subtitle={a.subtitle}
            art={a.art}
            onopen={() => ui.go({ name: "album", album: a })}
            onplay={() => player.playList(a.tracks, 0)}
          />
        {/each}
      </div>
    {:else if tab === "playlists"}
      <ul class="pls">
        <li>
          <button class="pl new" onclick={() => playlists.createInteractive().then((id) => id && ui.go({ name: "playlist", id }))}>
            <span class="plus"><Icon name="plus" size={22} /></span>
            <span class="t">New playlist</span>
          </button>
        </li>
        {#each playlists.list as p (p.id)}
          <li>
            <button class="pl" onclick={() => ui.go({ name: "playlist", id: p.id })}>
              <Mosaic covers={playlists.covers(p)} size={52} radius="8px" />
              <span class="t">{p.name}<small>{p.trackIds.length} {p.trackIds.length === 1 ? "song" : "songs"}</small></span>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <TrackList tracks={songs} />
    {/if}
    {#if library.tracks.length === 0 && !library.scanning}
      <div class="empty"><h2>No songs found</h2><p>None of your folders contain supported audio files. Add another folder or check the path in Settings.</p></div>
    {/if}
  {/if}
</div>

<style>
  .top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }
  .tools {
    display: flex;
    gap: 10px;
    margin-top: 8px;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 22px;
  }
  .tabs {
    position: relative;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    padding: 4px;
    border-radius: var(--r-pill);
    background: var(--well);
  }
  .tabs button {
    position: relative;
    z-index: 1;
    height: 32px;
    padding: 0 18px;
    border-radius: var(--r-pill);
    font-weight: 600;
    color: var(--ink-2);
    transition: color var(--t-fast);
  }
  .tabs button.on {
    color: var(--night);
  }
  .tabs small {
    font-weight: 500;
    opacity: 0.7;
    margin-left: 4px;
  }
  /* Sliding pill behind the active tab. */
  .ink {
    position: absolute;
    top: 4px;
    bottom: 4px;
    left: 4px;
    width: calc(50% - 4px);
    border-radius: var(--r-pill);
    background: var(--ink);
    transition: transform var(--t-med) var(--ease-spring);
  }
  .filter {
    width: 240px;
    border-radius: var(--r-pill);
  }
  :global(html[data-phone]) .bar {
    flex-direction: column;
    align-items: stretch;
  }
  :global(html[data-phone]) .filter {
    width: 100%;
  }
  :global(html[data-phone]) .tabs button {
    padding: 0 8px;
  }
  .emptyrow {
    margin-bottom: 12px;
  }
  .pls {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
  }
  .pl {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    padding: 6px;
    border-radius: 12px;
    text-align: left;
  }
  .pl:active {
    background: rgb(var(--ink-rgb) / 0.06);
  }
  .plus {
    width: 52px;
    height: 52px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: var(--well);
    border: 1px dashed var(--line);
  }
  .t {
    display: flex;
    flex-direction: column;
    font-weight: 600;
  }
  .t small {
    font-weight: 400;
    color: var(--ink-3);
  }
</style>
