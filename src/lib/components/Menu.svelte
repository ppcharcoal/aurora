<script lang="ts">
  import { scale } from "svelte/transition";
  import { ui, type MenuItem } from "../ui.svelte";
  import Icon from "./Icon.svelte";

  // One floating context menu for the whole app, with a single level of submenus.
  let el = $state<HTMLDivElement>();
  let pos = $state({ x: 0, y: 0 });
  let sub = $state<{ items: MenuItem[]; x: number; y: number } | null>(null);

  $effect(() => {
    const m = ui.menu;
    sub = null;
    if (!m || !el) return;
    // Keep the menu inside the window.
    const r = el.getBoundingClientRect();
    pos = {
      x: Math.min(m.x, innerWidth - r.width - 8),
      y: m.y + r.height > innerHeight - 8 ? Math.max(8, m.y - r.height) : m.y,
    };
  });

  function run(it: MenuItem) {
    if (it.submenu) return;
    ui.closeMenu();
    it.action?.();
  }

  function openSub(e: MouseEvent, it: MenuItem) {
    if (!it.submenu) {
      sub = null;
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const w = 220;
    const x = r.right + w + 8 > innerWidth ? r.left - w - 4 : r.right + 4;
    const h = Math.min(it.submenu.length * 36 + 12, 360);
    sub = { items: it.submenu, x, y: Math.min(r.top - 6, innerHeight - h - 8) };
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") ui.closeMenu();
  }
</script>

<svelte:window onkeydown={onKey} onblur={() => ui.closeMenu()} onresize={() => ui.closeMenu()} />

{#if ui.menu}
  <div class="scrim" role="presentation" onpointerdown={() => ui.closeMenu()} oncontextmenu={(e) => { e.preventDefault(); ui.closeMenu(); }}></div>
  <div
    class="menu"
    bind:this={el}
    style:left={`${pos.x}px`}
    style:top={`${pos.y}px`}
    role="menu"
    transition:scale={{ start: 0.96, duration: 120 }}
  >
    {#each ui.menu.items as it}
      {#if it.divider}
        <div class="div"></div>
      {:else}
        <button class="item" class:danger={it.danger} role="menuitem" onclick={() => run(it)} onpointerenter={(e) => openSub(e, it)}>
          {#if it.icon}<Icon name={it.icon} size={16} />{:else}<span class="sp"></span>{/if}
          <span class="lbl">{it.label}</span>
          {#if it.submenu}<Icon name="chevron" size={14} />{/if}
        </button>
      {/if}
    {/each}
  </div>
  {#if sub}
    <div class="menu sub" style:left={`${sub.x}px`} style:top={`${sub.y}px`} role="menu">
      {#each sub.items as it}
        {#if it.divider}
          <div class="div"></div>
        {:else}
          <button class="item" role="menuitem" onclick={() => run(it)}>
            {#if it.icon}<Icon name={it.icon} size={16} />{:else}<span class="sp"></span>{/if}
            <span class="lbl">{it.label}</span>
          </button>
        {/if}
      {/each}
    </div>
  {/if}
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 50;
  }
  .menu {
    position: fixed;
    z-index: 51;
    min-width: 210px;
    max-width: 280px;
    max-height: 360px;
    overflow-y: auto;
    padding: 6px;
    border-radius: 12px;
    background: var(--glass-strong);
    backdrop-filter: blur(24px) saturate(1.3);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
    transform-origin: top left;
  }
  .sub {
    width: 220px;
  }
  .item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 34px;
    padding: 0 10px;
    border-radius: 8px;
    color: var(--ink-2);
    text-align: left;
  }
  .item:hover,
  .item:focus-visible {
    background: rgb(var(--ink-rgb) / 0.08);
    color: var(--ink);
  }
  .item.danger:hover {
    color: var(--danger);
  }
  .lbl {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sp {
    width: 16px;
  }
  .div {
    height: 1px;
    margin: 5px 4px;
    background: var(--line);
  }
</style>
