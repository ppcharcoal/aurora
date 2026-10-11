<script lang="ts">
  import { lastfm } from "../lastfm.svelte";
  import { player } from "../player.svelte";
  import { ui } from "../ui.svelte";
  import Icon from "../components/Icon.svelte";
  import TrackList from "../components/TrackList.svelte";

  const tracks = $derived(lastfm.lovedLocal);
  const total = $derived(Object.keys(lastfm.loved).length);
  const missing = $derived(total - tracks.length);
</script>

<div class="page">
  <header class="hero">
    <div class="badge"><Icon name="heartFill" size={64} /></div>
    <div>
      <div class="kind">{lastfm.connected && lastfm.cfg.syncLoved ? "Synced with Last.fm" : "Songs you love"}</div>
      <h1>Loved</h1>
      <p class="muted">{tracks.length} {tracks.length === 1 ? "song" : "songs"} here{missing ? `, ${missing} loved elsewhere and not downloaded yet` : ""}</p>
      <div class="actions">
        <button class="btn primary big" onclick={() => player.playList(tracks, 0)} disabled={!tracks.length}><Icon name="play" size={16} /> Play</button>
        <button class="btn" onclick={() => player.shuffleAll(tracks)} disabled={!tracks.length}><Icon name="shuffle" size={16} /> Shuffle</button>
        {#if missing && lastfm.connected}
          <button class="btn" onclick={() => ui.go({ name: "downloads", tab: "lastfm" })}><Icon name="download" size={16} /> Get the missing ones</button>
        {:else if lastfm.connected && lastfm.cfg.syncLoved}
          <button class="btn" onclick={() => lastfm.syncLoved().catch(ui.error)}><Icon name="refresh" size={16} /> Sync now</button>
        {/if}
      </div>
    </div>
  </header>

  {#if tracks.length}
    <TrackList {tracks} />
  {:else}
    <div class="empty">
      <h2>Nothing loved yet</h2>
      <p>Press the ♥ next to the song that's playing, or right-click any song and choose Love. With Last.fm connected, songs you love on other devices show up here too.</p>
    </div>
  {/if}
</div>

<style>
  .hero {
    display: flex;
    align-items: flex-end;
    gap: 28px;
    margin-bottom: 28px;
  }
  .badge {
    width: 208px;
    height: 208px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 12px;
    color: #fff;
    background: linear-gradient(140deg, var(--violet), rgb(var(--accent-rgb)));
    box-shadow: var(--shadow);
  }
  .kind {
    color: var(--ink-2);
    font-size: 13px;
  }
  h1 {
    font-size: 64px;
    font-variation-settings: "wdth" 78;
    margin: 6px 0 8px;
  }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 18px;
    flex-wrap: wrap;
  }
  .big {
    height: 44px;
    padding: 0 24px;
  }
</style>
