<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { onMount, setContext } from "svelte";
  import { fade, fly } from "svelte/transition";
  import { downloads } from "./lib/downloads.svelte";
  import { player } from "./lib/player.svelte";
  import { loadPaths } from "./lib/paths";
  import { initMedia } from "./lib/media";
  import { playlists } from "./lib/playlists.svelte";
  import { profiles } from "./lib/profiles.svelte";
  import { stats } from "./lib/stats.svelte";
  import { theme } from "./lib/theme.svelte";
  import { settings } from "./lib/settings.svelte";
  import { library } from "./lib/sources/local.svelte";
  import { tools } from "./lib/tools.svelte";
  import { ui } from "./lib/ui.svelte";
  import AmbientBackground from "./lib/components/AmbientBackground.svelte";
  import Menu from "./lib/components/Menu.svelte";
  import NowPlayingBar from "./lib/components/NowPlayingBar.svelte";
  import PromptDialog from "./lib/components/PromptDialog.svelte";
  import TransitionEditor from "./lib/components/TransitionEditor.svelte";
  import TransitionList from "./lib/components/TransitionList.svelte";
  import { transitions } from "./lib/transitions.svelte";
  import QueuePanel from "./lib/components/QueuePanel.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import TitleBar from "./lib/components/TitleBar.svelte";
  import Toasts from "./lib/components/Toasts.svelte";
  import Album from "./lib/views/Album.svelte";
  import Downloads from "./lib/views/Downloads.svelte";
  import Discord from "./lib/views/Discord.svelte";
  import { discord } from "./lib/discord.svelte";
  import Home from "./lib/views/Home.svelte";
  import Library from "./lib/views/Library.svelte";
  import Playlist from "./lib/views/Playlist.svelte";
  import Profile from "./lib/views/Profile.svelte";
  import Loved from "./lib/views/Loved.svelte";
  import Friends from "./lib/views/Friends.svelte";
  import { lastfm } from "./lib/lastfm.svelte";
  import { output } from "./lib/output.svelte";
  import Search from "./lib/views/Search.svelte";
  import Settings from "./lib/views/Settings.svelte";
  import Setup from "./lib/views/Setup.svelte";
  import PhoneDock from "./lib/components/PhoneDock.svelte";
  import NowPlayingSheet from "./lib/components/NowPlayingSheet.svelte";
  import Visualizer from "./lib/components/Visualizer.svelte";
  import { isAndroid, isElectron } from "./lib/platform";
  import { loudness } from "./lib/loudness.svelte";

  // Lets styles tell the Linux (Electron) app apart; see the reduced-motion note in app.css.
  if (isElectron) document.documentElement.dataset.shell = "electron";

  let scroller = $state<HTMLElement>();
  let ready = $state(false);
  setContext("scroller", () => scroller);

  // Page transition + scroll reset happen when the *page* changes, not when
  // e.g. the search text changes.
  const navKey = $derived(
    ui.route.name === "album" ? `a:${ui.route.album.id}` : ui.route.name === "playlist" ? `p:${ui.route.id}` : ui.route.name,
  );
  $effect(() => {
    navKey;
    scroller?.scrollTo({ top: 0 });
    ui.closeMenu();
  });

  $effect(() => {
    document.documentElement.dataset.reduceMotion = String(settings.value.reduceMotion);
  });

  // Phone layout for the Android app (and very narrow windows).
  const narrow = window.matchMedia("(max-width: 720px)");
  const setPhone = () => {
    ui.phone = isAndroid || narrow.matches;
    document.documentElement.toggleAttribute("data-phone", ui.phone);
    if (isAndroid) document.documentElement.dataset.platform = "android";
  };
  // Android draws the app under the status and gesture bars. If this WebView
  // doesn't report those insets, leave typical room for them.
  if (isAndroid) {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;top:0;height:env(safe-area-inset-top,0px)";
    document.body.appendChild(probe);
    const reported = probe.getBoundingClientRect().height;
    probe.remove();
    const edgeToEdge = screen.height - window.innerHeight < 24;
    if (!reported && edgeToEdge) {
      document.documentElement.style.setProperty("--fallback-top", "28px");
      document.documentElement.style.setProperty("--fallback-bottom", "18px");
    }
  }
  setPhone();
  narrow.addEventListener("change", setPhone);

  const m = $derived(settings.value.reduceMotion ? 0 : 1);

  onMount(() => {
    (async () => {
      // The active profile decides which settings / playlists / stats to load.
      await Promise.all([loadPaths(), profiles.load(), initMedia()]);
      await settings.load();
      theme.init();
      // One part failing to load must not leave the whole app blank: report it and carry on.
      await Promise.all(
        [library.init(), playlists.load(), stats.load(), player.loadProfile(), transitions.load(), lastfm.load(), downloads.init(), tools.init(), discord.init()].map((p) =>
          p.catch(ui.error),
        ),
      );
      output.init().catch(() => {});
      loudness.init().catch(() => {});
      try {
        player.startNative();
      } catch (e) {
        ui.error(e);
      }
      ready = true;
      // Show the window once the first frame is ready (no white flash). Linux
      // (WebKitGTK) runs no animation frames while the window is hidden, so a
      // short timer shows it there too.
      const show = () => getCurrentWindow().show().catch(() => {});
      requestAnimationFrame(show);
      setTimeout(show, 120);
    })();

    const keys = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || ui.promptState) return;
      if (e.code === "Space") {
        e.preventDefault();
        player.toggle();
      } else if (e.ctrlKey && e.key === "ArrowRight") player.next();
      else if (e.ctrlKey && e.key === "ArrowLeft") player.prev();
      else if (e.altKey && e.key === "ArrowLeft") ui.back();
      else if (e.key === "ArrowRight" && player.current) player.seek(player.position + 5000);
      else if (e.key === "ArrowLeft" && player.current) player.seek(Math.max(0, player.position - 5000));
      else if (e.key.toLowerCase() === "q" && !e.ctrlKey) ui.queueOpen = !ui.queueOpen;
      else if (e.key.toLowerCase() === "v" && !e.ctrlKey && player.current) ui.vizOpen = !ui.vizOpen;
    };
    const mouse = (e: MouseEvent) => {
      if (e.button === 3) ui.back(); // mouse "back" button
    };
    // Block the browser's own context menu everywhere except text fields.
    const ctx = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName !== "INPUT") e.preventDefault();
    };
    window.addEventListener("keydown", keys);
    window.addEventListener("mouseup", mouse);
    window.addEventListener("contextmenu", ctx);
    return () => {
      window.removeEventListener("keydown", keys);
      window.removeEventListener("mouseup", mouse);
      window.removeEventListener("contextmenu", ctx);
    };
  });
</script>

<AmbientBackground />

<div class="shell">
  <TitleBar />
  {#if ready && !settings.value.setupDone}
    <Setup />
  {:else}
  <div class="body">
    {#if !ui.phone}<Sidebar />{/if}
    <main class="main" bind:this={scroller} onscroll={() => ui.menu && ui.closeMenu()}>
      {#if ready}
        {#key navKey}
          <div class="view" in:fly={{ y: 14 * m, duration: 360 * m, delay: 40 * m }} out:fade={{ duration: 0 }}>
            <!-- A page that hits an error shows it (and a way out) instead of leaving the app blank. -->
            <svelte:boundary onerror={(e) => console.error(e)}>
            {#if ui.route.name === "home"}
              <Home />
            {:else if ui.route.name === "library"}
              <Library />
            {:else if ui.route.name === "search"}
              <Search q={ui.route.q ?? ""} />
            {:else if ui.route.name === "downloads"}
              <Downloads tab={ui.route.tab} />
            {:else if ui.route.name === "discord"}
              <Discord />
            {:else if ui.route.name === "settings"}
              <Settings />
            {:else if ui.route.name === "album"}
              <Album album={ui.route.album} />
            {:else if ui.route.name === "playlist"}
              <Playlist id={ui.route.id} />
            {:else if ui.route.name === "profile"}
              <Profile />
            {:else if ui.route.name === "loved"}
              <Loved />
            {:else if ui.route.name === "friends"}
              <Friends />
            {/if}
            {#snippet failed(error, reset)}
              <div class="crash">
                <h2>This page ran into a problem</h2>
                <p class="muted">{error instanceof Error ? error.message : String(error)}</p>
                <div class="crash-row">
                  <button class="btn primary" onclick={reset}>Try again</button>
                  <button class="btn" onclick={() => { reset(); ui.go({ name: "home" }); }}>Go home</button>
                </div>
              </div>
            {/snippet}
            </svelte:boundary>
          </div>
        {/key}
      {/if}
    </main>
    {#if ui.queueOpen}
      <QueuePanel />
    {/if}
  </div>
  {#if ui.phone}
    <PhoneDock />
    {#if ui.sheetOpen}<NowPlayingSheet />{/if}
  {:else}
    <NowPlayingBar />
  {/if}
  {/if}
  {#if ui.vizOpen && player.current}<Visualizer />{/if}
  <Toasts />
</div>

<Menu />
<PromptDialog />
{#if ui.transitionList}
  <TransitionList title={ui.transitionList.title} tracks={ui.transitionList.tracks} />
{/if}
{#if ui.transitionEdit}
  {#key ui.transitionEdit}
    <TransitionEditor a={ui.transitionEdit.a} b={ui.transitionEdit.b} />
  {/key}
{/if}

<style>
  .shell {
    position: relative;
    z-index: 1;
    height: 100%;
    display: grid;
    grid-template-rows: auto 1fr auto;
    grid-template-columns: minmax(0, 1fr);
  }
  /* Floating panels over the background, separated by a small gutter.
     No backdrop blur on the big panels: the background is already blurred,
     and re-blurring a moving layer every frame would waste GPU time. */
  .body {
    position: relative;
    display: grid;
    grid-template-columns: 248px 1fr;
    gap: var(--gutter);
    padding: 0 var(--gutter);
    min-height: 0;
    overflow: hidden;
  }
  :global(html[data-phone]) .body {
    grid-template-columns: minmax(0, 1fr);
    padding: 0 6px;
  }
  :global(html[data-phone]) .main {
    border-radius: 16px;
    scrollbar-gutter: auto;
  }
  :global(html[data-phone]) .main :global(.page) {
    padding: 18px 16px 28px;
  }
  :global(html[data-phone]) .main :global(.page-title) {
    font-size: 32px;
    margin-bottom: 16px;
  }
  .main {
    position: relative;
    overflow-y: auto;
    overflow-x: hidden;
    border-radius: var(--r-panel);
    background: var(--panel);
    border: 1px solid var(--line);
    scrollbar-gutter: stable;
  }
  .crash {
    padding: 24px 4px;
    max-width: 560px;
  }
  .crash p {
    overflow-wrap: anywhere;
  }
  .crash-row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
</style>
