<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import { ui } from "../ui.svelte";

  let value = $state("");
  let input = $state<HTMLInputElement>();

  $effect(() => {
    if (ui.promptState) {
      value = ui.promptState.value;
      queueMicrotask(() => {
        input?.focus();
        input?.select();
      });
    }
  });

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (value.trim()) ui.settlePrompt(value.trim());
  }
</script>

{#if ui.promptState}
  <div class="back" transition:fade={{ duration: 150 }} role="presentation" onpointerdown={() => ui.settlePrompt(null)}></div>
  <form class="dlg" onsubmit={submit} transition:scale={{ start: 0.95, duration: 180 }}>
    <h2>{ui.promptState.title}</h2>
    <input
      class="field"
      bind:this={input}
      bind:value
      placeholder={ui.promptState.placeholder}
      spellcheck="false"
      onkeydown={(e) => e.key === "Escape" && ui.settlePrompt(null)}
    />
    <div class="row">
      <button type="button" class="btn" onclick={() => ui.settlePrompt(null)}>Cancel</button>
      <button type="submit" class="btn primary" disabled={!value.trim()}>Save</button>
    </div>
  </form>
{/if}

<style>
  .back {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgb(10 8 14 / 0.55);
  }
  .dlg {
    position: fixed;
    z-index: 61;
    left: 50%;
    top: 34%;
    width: min(420px, calc(100vw - 32px));
    margin-left: min(-210px, calc(-50vw + 16px));
    padding: 22px;
    border-radius: var(--r-panel);
    background: var(--night-2);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
  }
  h2 {
    font-size: 22px;
    margin-bottom: 16px;
  }
  .row {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 18px;
  }
</style>
