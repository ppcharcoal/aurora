<script lang="ts">
  import { onMount } from "svelte";
  import { discord } from "../discord.svelte";
  import { iconFor, output } from "../output.svelte";
  import { isAndroid, isLinux, systemPicksOutput } from "../platform";
  import { settings } from "../settings.svelte";
  import Icon from "./Icon.svelte";

  onMount(() => {
    output.refresh().catch(() => {});
  });
  const chosen = $derived(settings.value.audioOutput?.id ?? null);
</script>

{#if discord.live}
  <div class="access">
    <p>Aurora is playing through your Discord bot right now, so this computer stays quiet. It plays here again when the bot leaves the voice channel (Discord page).</p>
  </div>
{/if}

{#if systemPicksOutput}
  <div class="access">
    <p>
      On Linux, Aurora plays through your system's sound output. To send it to other speakers or headphones, use your desktop's sound
      menu, or <b>pavucontrol</b> → Playback → Aurora (works with PipeWire and PulseAudio).
    </p>
  </div>
{:else}
<ul class="outs" role="radiogroup" aria-label="Audio output">
  <li>
    <button role="radio" aria-checked={!chosen} class:on={!chosen} onclick={() => output.select(null)}>
      <Icon name="output" size={18} />
      <span class="name">System default<small>{isAndroid ? "Whatever Android picks (Bluetooth when connected)" : isLinux ? "Follows your system's sound setting" : "Follows Windows' sound setting"}</small></span>
      {#if !chosen}<Icon name="check" size={16} stroke={2.4} />{/if}
    </button>
  </li>
  {#each output.devices as d (d.id)}
    <li>
      <button role="radio" aria-checked={chosen === d.id} class:on={chosen === d.id} onclick={() => output.select(d)}>
        <Icon name={iconFor(d.kind)} size={18} />
        <span class="name">{d.label}</span>
        {#if chosen === d.id}<Icon name="check" size={16} stroke={2.4} />{/if}
      </button>
    </li>
  {/each}
  {#if settings.value.audioOutput && !output.devices.some((d) => d.id === settings.value.audioOutput?.id)}
    <li>
      <button role="radio" aria-checked="true" class="on gone" disabled>
        <Icon name="output" size={18} />
        <span class="name">{settings.value.audioOutput.label}<small>Not connected; the default plays until it's back</small></span>
        <Icon name="check" size={16} stroke={2.4} />
      </button>
    </li>
  {/if}
</ul>

{/if}

{#if output.needsAccess && !isAndroid && !isLinux}
  <div class="access">
    <p>Windows shows Aurora the names of your speakers and headphones after a quick, one-time check that briefly touches the microphone. Nothing is recorded.</p>
    <button class="btn" onclick={() => output.refresh(true)} disabled={output.busy}><Icon name="refresh" size={15} /> Show my devices</button>
  </div>
{/if}

<style>
  .outs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .outs button {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 46px;
    padding: 8px 14px;
    border-radius: 12px;
    text-align: left;
    background: var(--well);
    border: 1px solid var(--line);
    transition: border-color var(--t-fast), background var(--t-fast);
  }
  .outs button:hover {
    border-color: rgb(var(--accent-rgb) / 0.5);
  }
  .outs button.on {
    border-color: var(--accent);
    background: rgb(var(--accent-rgb) / 0.1);
  }
  .outs button.on :global(svg:last-child) {
    color: var(--accent);
  }
  .outs button.gone {
    opacity: 0.7;
  }
  .name {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  small {
    font-weight: 400;
    font-size: 12px;
    color: var(--ink-3);
  }
  .access {
    display: flex;
    gap: 14px;
    align-items: center;
    margin-top: 12px;
    font-size: 13px;
    color: var(--ink-3);
  }
  .access p {
    margin: 0;
    flex: 1;
  }
</style>
