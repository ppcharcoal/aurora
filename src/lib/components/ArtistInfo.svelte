<script lang="ts">
  import { slide } from "svelte/transition";
  import { lastfm, type ArtistInfo } from "../lastfm.svelte";
  import { ui } from "../ui.svelte";

  let { artist, album }: { artist: string; album?: string } = $props();
  let info = $state<ArtistInfo | null>(null);
  let albumInfo = $state<{ tags: string[]; wiki: string } | null>(null);
  let open = $state(false);

  $effect(() => {
    info = null;
    albumInfo = null;
    lastfm.artistInfo(artist).then((i) => (info = i), () => {});
    if (album) lastfm.albumTags(artist, album).then((a) => (albumInfo = a), () => {});
  });

  const tags = $derived([...new Set([...(albumInfo?.tags ?? []), ...(info?.tags ?? [])])].slice(0, 8));
  const fmt = (n?: number) => (n ? n.toLocaleString() : "");
  const search = (q: string) => ui.go({ name: "search", q });
  /** The whole card opens a song search for the artist (inner buttons and selected text excepted). */
  function moreSongs(e?: MouseEvent) {
    if (e && ((e.target as HTMLElement).closest("button") || window.getSelection()?.toString())) return;
    ui.searchMode = "songs";
    search(info?.name ?? artist);
  }
</script>

{#if info && (info.bio || tags.length)}
  <!-- The card is a big click target; the "More songs" button is the keyboard route. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <section class="about" transition:slide={{ duration: 250 }} onclick={moreSongs} title={`Find more songs by ${info.name}`}>
    <div class="pic">
      {#if info.picture}<img src={info.picture} alt="" loading="lazy" />{:else}<span>{info.name.charAt(0)}</span>{/if}
    </div>
    <div class="body">
      <div class="head">
        <h2>About {info.name}</h2>
        <button class="go" onclick={() => moreSongs()}>More songs by {info.name} →</button>
      </div>
      <p class="stats">
        {#if info.listeners}{fmt(info.listeners)} listeners on Last.fm{/if}{#if info.userPlays}, you've played them {fmt(info.userPlays)} times{/if}
      </p>
      {#if tags.length}
        <div class="tags">{#each tags as t}<button class="tag" onclick={() => search(t)}>{t}</button>{/each}</div>
      {/if}
      {#if albumInfo?.wiki}<p class="bio">{albumInfo.wiki}</p>{/if}
      {#if info.bio}
        <p class="bio" class:open>{info.bio}</p>
        {#if info.bio.length > 280}<button class="more" onclick={() => (open = !open)}>{open ? "Show less" : "Read more"}</button>{/if}
      {/if}
      {#if info.similar.length}
        <p class="sim">
          Similar:
          {#each info.similar as s, i}<button class="link" onclick={() => search(s)}>{s}</button>{i < info.similar.length - 1 ? ", " : ""}{/each}
        </p>
      {/if}
    </div>
  </section>
{/if}

<style>
  .about {
    display: flex;
    gap: 24px;
    margin-top: 36px;
    padding: 22px;
    border-radius: var(--r-panel);
    background: rgb(var(--ink-rgb) / 0.04);
    border: 1px solid var(--line);
    max-width: 980px;
    cursor: pointer;
    transition: background 160ms, border-color 160ms;
  }
  .about:hover {
    background: rgb(var(--ink-rgb) / 0.07);
    border-color: rgb(var(--accent-rgb) / 0.4);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
  }
  .go {
    padding: 5px 12px;
    border-radius: var(--r-pill);
    font-size: 12px;
    font-weight: 700;
    color: var(--on-accent);
    background: var(--accent);
  }
  .go:hover {
    filter: brightness(1.08);
  }
  .pic {
    width: 120px;
    height: 120px;
    flex: none;
    border-radius: 50%;
    overflow: hidden;
    display: grid;
    place-items: center;
    font: 700 44px var(--font-display);
    color: var(--on-accent);
    background: linear-gradient(140deg, var(--violet), rgb(var(--accent-rgb)));
  }
  .pic img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .body {
    min-width: 0;
  }
  h2 {
    font-size: 22px;
  }
  .stats {
    margin: 4px 0 10px;
    font-size: 13px;
    color: var(--ink-3);
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 12px;
  }
  .tag {
    padding: 3px 10px;
    border-radius: var(--r-pill);
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-2);
    background: var(--well);
    border: 1px solid var(--line);
  }
  .tag:hover {
    color: var(--ink);
  }
  .bio {
    margin: 0 0 6px;
    max-width: 72ch;
    color: var(--ink-2);
    line-height: 1.6;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
    user-select: text;
  }
  .bio.open {
    display: block;
  }
  .more,
  .link {
    color: var(--ink);
    text-decoration: underline;
    text-underline-offset: 3px;
    font-size: 13px;
  }
  .sim {
    margin: 10px 0 0;
    font-size: 13px;
    color: var(--ink-3);
  }
</style>
