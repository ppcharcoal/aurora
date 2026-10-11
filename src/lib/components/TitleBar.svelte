<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { onMount, untrack } from "svelte";
  import { settings } from "../settings.svelte";
  import { ui } from "../ui.svelte";
  import Icon from "./Icon.svelte";

  const win = getCurrentWindow();
  let maximized = $state(false);
  let query = $state("");
  const sources = [
    { v: "catalog", label: "Music only", icon: "check", tip: "Real songs and albums from a music catalog. Aurora picks the best upload to download." },
    { v: "youtube", label: "YouTube", icon: "youtube", tip: "Anything on YouTube: remixes, live sets, covers." },
    { v: "soundcloud", label: "SoundCloud", icon: "soundcloud", tip: "Independent artists, DJ mixes, remixes. Some tracks only offer a 30-second clip." },
  ] as const;
  let input: HTMLInputElement;

  onMount(() => {
    win.isMaximized().then((m) => (maximized = m), () => {});
    const un = win.onResized(async () => (maximized = await win.isMaximized().catch(() => false))).catch(() => () => {});
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey && e.key.toLowerCase() === "f") || (e.key === "/" && !isTyping(e))) {
        e.preventDefault();
        input?.focus();
        input?.select();
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      un.then((f) => f());
      window.removeEventListener("keydown", key);
    };
  });

  function isTyping(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    return t.tagName === "INPUT" || t.tagName === "TEXTAREA";
  }

  // Only follow the route when *it* changes (e.g. a search started from Home).
  // Reading `query` untracked stops this from overwriting what you're typing.
  $effect(() => {
    const q = ui.route.name === "search" ? ui.route.q : undefined;
    if (q !== undefined && q !== untrack(() => query)) query = q;
  });

  function onInput(e: Event & { currentTarget: HTMLInputElement }) {
    // Use the input's own value: it's always the latest keystroke.
    query = e.currentTarget.value;
    if (ui.route.name === "search") ui.route = { name: "search", q: query };
    else ui.go({ name: "search", q: query });
  }
</script>

<header class="bar" data-tauri-drag-region>
  <div class="brand" data-tauri-drag-region>
    <button class="nav" onclick={() => ui.back()} aria-label="Back"><Icon name="back" size={16} /></button>
    <span class="name" data-tauri-drag-region>Aurora</span>
  </div>

  <div class="searchrow">
    <label class="search">
      <Icon name="search" size={15} />
      <input
        bind:this={input}
        value={query}
        oninput={onInput}
        onfocus={() => ui.route.name !== "search" && ui.go({ name: "search", q: query })}
        placeholder={{ catalog: "Search songs and albums", youtube: "Search YouTube", soundcloud: "Search SoundCloud" }[settings.value.searchSource]}
        spellcheck="false"
      />
      <kbd>Ctrl F</kbd>
    </label>
    <div class="sources" role="radiogroup" aria-label="Search in">
      {#each sources as src (src.v)}
        <button
          role="radio"
          aria-checked={settings.value.searchSource === src.v}
          class:on={settings.value.searchSource === src.v}
          onclick={() => settings.set("searchSource", src.v)}
          title={src.tip}
        >
          <Icon name={src.icon} size={14} stroke={2.2} />
          <span>{src.label}</span>
        </button>
      {/each}
    </div>
  </div>

  {#if ui.phone}
    <button class="gear" class:on={ui.route.name === "settings"} onclick={() => ui.go({ name: "settings" })} aria-label="Settings"><Icon name="settings" size={19} /></button>
  {:else}
  <div class="controls">
    <button onclick={() => win.minimize()} aria-label="Minimize"><Icon name="min" size={14} /></button>
    <button onclick={() => win.toggleMaximize()} aria-label={maximized ? "Restore" : "Maximize"}>
      <Icon name={maximized ? "restore" : "max"} size={12} />
    </button>
    <button class="close" onclick={() => win.close()} aria-label="Close"><Icon name="x" size={14} /></button>
  </div>
  {/if}
</header>

<style>
  .bar {
    position: relative;
    z-index: 5;
    height: 48px;
    display: grid;
    grid-template-columns: 1fr minmax(440px, 760px) 1fr;
    align-items: center;
    padding-left: 12px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 100%;
  }
  .nav {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    color: var(--ink-2);
  }
  .nav:hover {
    background: rgb(var(--ink-rgb) / 0.08);
    color: var(--ink);
  }
  .name {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 16px;
    font-variation-settings: "wdth" 80;
    letter-spacing: 0.01em;
    background: linear-gradient(90deg, var(--violet), var(--accent));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .searchrow {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .sources {
    flex: none;
    display: flex;
    gap: 2px;
    padding: 3px;
    height: 34px;
    border-radius: var(--r-pill);
    border: 1px solid var(--line);
    background: var(--well);
  }
  .sources button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 10px;
    border-radius: var(--r-pill);
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-3);
    transition:
      color var(--t-fast),
      background var(--t-fast);
  }
  .sources button:hover {
    color: var(--ink);
  }
  .sources button.on {
    color: var(--accent);
    background: rgb(var(--accent-rgb) / 0.14);
  }
  @media (max-width: 1180px) {
    .sources button span {
      display: none;
    }
  }
  .search {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 34px;
    padding: 0 8px 0 14px;
    border-radius: var(--r-pill);
    background: var(--well);
    border: 1px solid var(--line);
    color: var(--ink-3);
    transition:
      border-color var(--t-fast),
      background var(--t-fast);
  }
  .search:focus-within {
    border-color: rgb(var(--accent-rgb) / 0.6);
    background: var(--well);
    color: var(--ink);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    background: none;
  }
  .search input::placeholder {
    color: var(--ink-3);
  }
  kbd {
    font: 11px var(--font-ui);
    color: var(--ink-3);
    padding: 2px 7px;
    border-radius: 6px;
    border: 1px solid var(--line);
  }
  .controls {
    justify-self: end;
    display: flex;
    height: 100%;
  }
  .controls button {
    width: 46px;
    height: 100%;
    display: grid;
    place-items: center;
    color: var(--ink-2);
    transition: background var(--t-fast);
  }
  .controls button:hover {
    background: rgb(var(--ink-rgb) / 0.08);
    color: var(--ink);
  }
  /* Phone: back, search, sources, settings; under the status bar. */
  :global(html[data-phone]) .bar {
    height: calc(56px + var(--safe-top));
    padding: var(--safe-top) 6px 0 4px;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 4px;
  }
  :global(html[data-phone]) .name,
  :global(html[data-phone]) kbd,
  :global(html[data-phone]) .sources button span {
    display: none;
  }
  :global(html[data-phone]) .nav,
  .gear {
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--ink-2);
  }
  .gear.on {
    color: var(--accent);
  }
  :global(html[data-phone]) .search,
  :global(html[data-phone]) .sources {
    height: 40px;
  }
  :global(html[data-phone]) .sources button {
    padding: 0 8px;
  }
  :global(html[data-phone]) .searchrow {
    min-width: 0;
    gap: 6px;
  }
  .controls .close:hover {
    background: #c42b1c;
    color: white;
  }
</style>
