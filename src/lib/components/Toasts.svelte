<script lang="ts">
  import { fly } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { ui } from "../ui.svelte";
  import Icon from "./Icon.svelte";
</script>

<div class="toasts" aria-live="polite">
  {#each ui.toasts as t (t.id)}
    <div class="toast {t.kind}" in:fly={{ y: 16, duration: 300 }} out:fly={{ x: 40, duration: 200 }} animate:flip={{ duration: 220 }}>
      <span>{t.text}</span>
      <button onclick={() => ui.dismiss(t.id)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: absolute;
    left: 50%;
    bottom: 104px;
    transform: translateX(-50%);
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: 560px;
    padding: 10px 10px 10px 16px;
    border-radius: 12px;
    background: var(--glass-strong);
    backdrop-filter: blur(20px);
    border: 1px solid var(--line);
    box-shadow: 0 12px 30px rgb(0 0 0 / 0.35);
  }
  .toast.error {
    border-color: rgb(255 110 110 / 0.55);
  }
  .toast.success {
    border-color: rgb(var(--accent-rgb) / 0.45);
  }
  button {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border-radius: 6px;
    color: var(--ink-3);
    flex: none;
  }
  button:hover {
    color: var(--ink);
  }
</style>
