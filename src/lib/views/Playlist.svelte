<script lang="ts">
  import { library } from "../sources/local.svelte";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { totalTime } from "../format";
  import { player } from "../player.svelte";
  import { playlists } from "../playlists.svelte";
  import { ui } from "../ui.svelte";
  import { isAndroid } from "../platform";
  import Icon from "../components/Icon.svelte";
  import Mosaic from "../components/Mosaic.svelte";
  import TrackList from "../components/TrackList.svelte";

  let { id }: { id: string } = $props();

  const p = $derived(playlists.get(id));
  const tracks = $derived(p ? playlists.tracks(p) : []);
  const total = $derived(tracks.reduce((s, t) => s + t.durationMs, 0));
  const missing = $derived(p ? p.trackIds.filter((id) => !library.byId.has(id)).length : 0);

  async function rename() {
    if (!p) return;
    const name = await ui.prompt("Rename playlist", "Playlist name", p.name);
    if (name) playlists.rename(p.id, name);
  }

  async function del() {
    if (!p) return;
    const name = p.name;
    const yes = await ask(`Delete the playlist “${name}”? The songs stay in your library.`, {
      title: "Delete playlist",
      kind: "warning",
      okLabel: "Delete",
    });
    if (yes) {
      playlists.remove(p.id);
      ui.toast(`Deleted “${name}”`);
      ui.go({ name: "home" });
    }
  }

  function more(e: MouseEvent) {
    if (!p) return;
    const id = p.id;
    ui.openMenu(e, [
      { label: "Rename", icon: "edit", action: rename },
      { label: "Choose cover image…", icon: "reveal", action: () => playlists.chooseCover(id) },
      ...(p.cover ? [{ label: "Remove cover image", icon: "x" as const, action: () => playlists.removeCover(id) }] : []),
      { label: "", divider: true },
      { label: "Delete playlist", icon: "trash", danger: true, action: del },
    ]);
  }
</script>

{#if p}
  <div class="page">
    <header class="hero">
      <button class="cover" onclick={() => playlists.chooseCover(p.id)} title="Choose cover image">
        <Mosaic covers={playlists.covers(p)} size={208} radius="12px" />
        <span class="overlay"><Icon name="edit" size={26} /><span>Choose image</span></span>
      </button>
      <div class="info">
        <div class="kind">Playlist</div>
        <button class="name" onclick={rename} title="Rename">
          <h1 class:long={p.name.length > 28}>{p.name}</h1>
        </button>
        <p class="muted">
          {tracks.length} {tracks.length === 1 ? "song" : "songs"}{total ? `, ${totalTime(total)}` : ""}
          {#if missing}<span class="warn">— {missing} missing from your library</span>{/if}
        </p>
        <div class="actions">
          <button class="btn primary big" onclick={() => player.playList(tracks, 0)} disabled={!tracks.length}>
            <Icon name="play" size={16} /> Play
          </button>
          <button class="btn" onclick={() => player.shuffleAll(tracks)} disabled={!tracks.length}>
            <Icon name="shuffle" size={16} /> Shuffle
          </button>
          {#if !isAndroid}
            <button class="btn" onclick={() => (ui.transitionList = { title: p?.name ?? "Playlist", tracks })} disabled={tracks.length < 2} title="Transitions between the songs">
              <Icon name="next" size={16} /> Transitions
            </button>
          {/if}
          <button class="btn round" onclick={more} aria-label="Playlist options"><Icon name="more" size={18} stroke={3} /></button>
        </div>
      </div>
    </header>

    {#if tracks.length}
      <p class="tip muted">{ui.phone ? "Tap ⋯ on a song for more, or press and hold it." : "Drag songs to reorder. Right-click a song for more."}</p>
      <TrackList {tracks} playlistId={p.id} />
    {:else}
      <div class="empty">
        <h2>Nothing here yet</h2>
        <p>Search YouTube and use the playlist button on a result to download straight into “{p.name}”, or {ui.phone ? "use ⋯ on" : "right-click"} any song in your library.</p>
        <button class="btn primary" onclick={() => ui.go({ name: "search" })}><Icon name="search" size={16} /> Find music</button>
      </div>
    {/if}
  </div>
{:else}
  <div class="page empty"><h2>This playlist no longer exists</h2></div>
{/if}

<style>
  .hero {
    display: flex;
    align-items: flex-end;
    gap: 28px;
    margin-bottom: 20px;
  }
  .hero :global(.mosaic),
  .hero :global(.art),
  .hero :global(.empty) {
    box-shadow: var(--shadow);
  }
  .info {
    min-width: 0;
  }
  .cover {
    position: relative;
    flex: none;
    border-radius: 12px;
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border-radius: 12px;
    font-weight: 600;
    color: var(--ink);
    background: rgb(15 12 20 / 0.6);
    backdrop-filter: blur(2px);
    opacity: 0;
    transition: opacity var(--t-fast);
  }
  .cover:hover .overlay,
  .cover:focus-visible .overlay {
    opacity: 1;
  }
  .kind {
    color: var(--ink-2);
    font-size: 13px;
  }
  .name {
    display: block;
    text-align: left;
    max-width: 100%;
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
  .warn {
    color: var(--warn);
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
  .round {
    width: 36px;
    padding: 0;
    justify-content: center;
  }
  .tip {
    font-size: 12px;
    margin: 0 0 6px 14px;
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
  :global(html[data-phone]) .name {
    margin: 0 auto;
    text-align: center;
  }
  :global(html[data-phone]) .tip {
    margin-left: 4px;
  }
</style>
