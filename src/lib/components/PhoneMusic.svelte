<script lang="ts">
  import { native } from "../native";
  import { library } from "../sources/local.svelte";
  import { ui } from "../ui.svelte";
  import Icon from "./Icon.svelte";

  // Android: add music that's already on the phone, found through Android's
  // own music index. Aurora reads those files where they are (no copies).
  interface Folder {
    path: string;
    name: string;
    count: number;
  }
  let folders = $state<Folder[] | null>(null);
  let chosen = $state<string[]>([]);
  let busy = $state(false);
  let denied = $state(false);

  async function find() {
    busy = true;
    try {
      const a = await native.call<{ granted: boolean }>("musicAccess");
      denied = !a.granted;
      if (!a.granted) return;
      const r = await native.call<{ folders: Folder[] }>("phoneFolders");
      folders = r.folders;
      // Chat apps' and recorder folders hold voice notes more than music: not ticked by default.
      const chatty = /whatsapp|telegram|signal|messenger|recordings|voice|call/i;
      chosen = r.folders.filter((f) => !library.covers(f.path) && !chatty.test(f.path)).map((f) => f.path);
    } catch (e) {
      ui.error(e);
    } finally {
      busy = false;
    }
  }

  async function add() {
    busy = true;
    try {
      for (const p of chosen) await library.addFolder(p);
      ui.toast(`Added ${chosen.length} ${chosen.length === 1 ? "folder" : "folders"} from your phone`, "success");
      folders = null;
    } catch (e) {
      ui.error(e);
    } finally {
      busy = false;
    }
  }

  const toggle = (p: string) => (chosen = chosen.includes(p) ? chosen.filter((x) => x !== p) : [...chosen, p]);
</script>

{#if folders}
  {#if folders.length === 0}
    <p class="muted">No music found on this phone (outside Aurora).</p>
  {:else}
    <ul class="list">
      {#each folders as f (f.path)}
        {@const have = library.covers(f.path)}
        <li>
          <label class:have>
            <input type="checkbox" checked={have || chosen.includes(f.path)} disabled={have || busy} onchange={() => toggle(f.path)} />
            <span class="name">{f.name}<small>{f.count} {f.count === 1 ? "song" : "songs"}{have ? " · in your library" : ""}</small></span>
          </label>
        </li>
      {/each}
    </ul>
    <div class="row">
      <button class="btn primary" onclick={add} disabled={busy || !chosen.length}>
        <Icon name="plus" size={15} /> {busy ? "Adding…" : `Add ${chosen.length || ""} ${chosen.length === 1 ? "folder" : "folders"}`}
      </button>
      <button class="btn" onclick={() => (folders = null)} disabled={busy}>Cancel</button>
    </div>
  {/if}
{:else}
  <button class="btn" onclick={find} disabled={busy}><Icon name="folder" size={15} /> {busy ? "Looking…" : "Add music from this phone"}</button>
  {#if denied}
    <p class="note">Aurora needs the “Music and audio” permission for this. If you said no, allow it in Android Settings → Apps → Aurora → Permissions.</p>
  {/if}
{/if}

<style>
  .list {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
    display: grid;
    gap: 4px;
  }
  label {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 10px;
    border-radius: 10px;
    background: var(--well);
  }
  label.have {
    opacity: 0.6;
  }
  input {
    width: 18px;
    height: 18px;
    accent-color: var(--accent);
  }
  .name {
    display: flex;
    flex-direction: column;
    min-width: 0;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  small {
    font-weight: 400;
    font-size: 12px;
    color: var(--ink-3);
  }
  .row {
    display: flex;
    gap: 10px;
  }
  .note {
    font-size: 13px;
    color: var(--ink-3);
  }
</style>
