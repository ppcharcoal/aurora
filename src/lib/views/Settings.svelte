<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { join } from "@tauri-apps/api/path";
  import { ask, message, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
  import { revealItemInDir } from "@tauri-apps/plugin-opener";
  import { onMount } from "svelte";
  import { flushSaves, pauseSaves } from "../store";
  import { settings, type Quality } from "../settings.svelte";
  import { library } from "../sources/local.svelte";
  import { player } from "../player.svelte";
  import { defaultFolderLabel, isAndroid, isLinux, systemThemeLabel } from "../platform";
  import { theme } from "../theme.svelte";
  import { tools } from "../tools.svelte";
  import { ui } from "../ui.svelte";
  import Icon from "../components/Icon.svelte";
  import DataLimit from "../components/DataLimit.svelte";
  import OutputPicker from "../components/OutputPicker.svelte";
  import PhoneMusic from "../components/PhoneMusic.svelte";
  import { defaultMusicFolder, documentsDir, isOldPhoneDefault, musicDir, native, prettyPath } from "../native";

  async function addFolder() {
    const dir = await openDialog({ directory: true, multiple: false, title: "Choose a music folder" });
    if (typeof dir === "string") library.addFolder(dir).catch(ui.error);
  }

  async function chooseDownloadFolder() {
    const dir = await openDialog({ directory: true, multiple: false, title: "Save downloads to…" });
    if (typeof dir !== "string") return;
    settings.set("downloadFolder", dir);
    if (!library.covers(dir)) library.addFolder(dir).catch(ui.error);
  }

  const qualities: { v: Quality; label: string; note: string }[] = [
    { v: "original", label: "Space saver", note: "≈ half the size" },
    { v: "best", label: "Best MP3", note: "V0, ≈245 kbps" },
    { v: "320", label: "320 kbps", note: "largest" },
    { v: "192", label: "192 kbps", note: "smaller" },
    { v: "128", label: "128 kbps", note: "smallest" },
  ];
  // Phones keep the stream as it comes; they choose between the best and the smallest one.
  const phoneQualities: { v: Quality; label: string; note: string }[] = [
    { v: "original", label: "Standard", note: "≈128 kbps AAC" },
    { v: "small", label: "Space saver", note: "≈48 kbps, ⅓ the size" },
  ];

  /* ---------------- storage ---------------- */
  let slimEstimate = $state<{ files: number; bytes: number } | null>(null);
  let slimming = $state(false);
  let sprog = $state<{ done: number; total: number } | null>(null);

  function estimateSlim() {
    invoke<{ files: number; bytes: number }>("storage_estimate").then((e) => (slimEstimate = e)).catch(() => {});
  }

  async function slimCovers() {
    slimming = true;
    sprog = null;
    const un = await listen<{ done: number; total: number }>("storage://progress", (e) => (sprog = e.payload));
    try {
      const r = await invoke<{ files: number; saved: number; skipped: number }>("storage_slim", { skip: player.current?.path ?? null });
      ui.toast(
        r.files ? `Freed ${size(r.saved)} in ${r.files} songs.${r.skipped ? ` ${r.skipped} skipped and left as they were.` : ""}` : "Nothing to slim down.",
        "success",
      );
      await library.rescan();
      estimateSlim();
    } catch (e) {
      ui.error(e);
    } finally {
      un();
      slimming = false;
    }
  }

  /* ---------------- duplicate songs ---------------- */
  let removing = $state(false);
  let armed = $state(false);
  const dupCount = $derived(library.duplicates.reduce((n, g) => n + g.length - 1, 0));
  const dupBytes = $derived(library.duplicates.reduce((n, g) => n + g.slice(1).reduce((m, t) => m + (t.size ?? 0), 0), 0));

  async function removeCopies() {
    // Two taps: deleting files can't be undone.
    if (!armed) {
      armed = true;
      setTimeout(() => (armed = false), 4000);
      return;
    }
    armed = false;
    removing = true;
    try {
      const n = await library.removeCopies();
      ui.toast(`Deleted ${n} extra ${n === 1 ? "copy" : "copies"}.`, "success");
      // Playlists, history and stats were moved on disk: load them fresh.
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      ui.error(e);
    } finally {
      removing = false;
    }
  }

  /* ---------------- backup & restore ---------------- */
  let estimate = $state<{ tracks: number; bytes: number; folders: number } | null>(null);
  let includeMusic = $state(true);
  let busy = $state<"backup" | "restore" | null>(null);
  let bprog = $state<{ step: string; done: number; total: number } | null>(null);

  onMount(() => {
    invoke<typeof estimate>("backup_estimate").then((e) => (estimate = e)).catch(() => {});
    estimateSlim();
    const un = listen<{ step: string; done: number; total: number }>("backup://progress", (e) => (bprog = e.payload));
    return () => {
      un.then((f) => f());
    };
  });

  const size = (b: number) =>
    b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;

  async function createBackup() {
    const d = new Date();
    const name = `Aurora backup ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.zip`;
    if (isAndroid) return createBackupPhone(name);
    const dest = await saveDialog({
      title: "Save backup as",
      defaultPath: await join(await documentsDir(), name),
      filters: [{ name: "Zip archive", extensions: ["zip"] }],
    });
    if (!dest) return;
    busy = "backup";
    bprog = null;
    try {
      await flushSaves();
      await invoke("backup_create", { dest, includeMusic });
      ui.toast("Backup saved", "success");
      revealItemInDir(dest).catch(() => {});
    } catch (e) {
      ui.error(e);
    } finally {
      busy = null;
      bprog = null;
    }
  }

  /** Phone: Android's "save as" screen hands over the file; Aurora writes the zip into it. */
  async function createBackupPhone(name: string) {
    const { fd } = await native.call<{ fd: number }>("createDocument", { name });
    if (fd < 0) return;
    busy = "backup";
    bprog = null;
    try {
      await flushSaves();
      await invoke("backup_create_fd", { fd, includeMusic });
      ui.toast("Backup saved", "success");
    } catch (e) {
      ui.error(e);
    } finally {
      busy = null;
      bprog = null;
    }
  }

  async function restoreBackupPhone() {
    const { fd } = await native.call<{ fd: number }>("openDocument");
    if (fd < 0) return;
    const cur = settings.value.downloadFolder;
    const musicDest = cur && !isOldPhoneDefault(cur) ? cur : await defaultMusicFolder();
    const ok = await ask(
      `Restore this backup?\n\nIts music is copied into ${prettyPath(musicDest)} on this phone.`+" Profiles from the backup are added (a profile that already exists here is replaced by the backup's version). Aurora restarts when it's done.",
      { title: "Restore backup", kind: "info", okLabel: "Restore" },
    );
    if (!ok) return;
    busy = "restore";
    bprog = null;
    try {
      await flushSaves();
      pauseSaves();
      const r = await invoke<{ tracks: number; skipped: number }>("backup_restore_fd", { fd, musicDest });
      ui.toast(`Restored ${r.tracks} songs${r.skipped ? ` (${r.skipped} skipped)` : ""}. Restarting…`, "success");
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      ui.error(e);
      busy = null;
      bprog = null;
      location.reload();
    }
  }

  async function restoreBackup() {
    if (isAndroid) return restoreBackupPhone();
    try {
      await restoreBackupDesktop();
    } catch (e) {
      ui.error(e);
    }
  }

  async function restoreBackupDesktop() {
    const zip = await openDialog({
      title: "Choose an Aurora backup",
      multiple: false,
      directory: false,
      filters: [{ name: "Zip archive", extensions: ["zip"] }],
    });
    if (typeof zip !== "string") return;
    const musicDest = await openDialog({
      title: "Where should the restored music go?",
      directory: true,
      multiple: false,
      defaultPath: await musicDir(),
    });
    if (typeof musicDest !== "string") return;
    const ok = await ask(
      `Restore this backup?\n\nMusic is copied into ${musicDest}. Profiles from the backup are added here (a profile that already exists here is replaced by the backup's version). Aurora restarts when it's done.`,
      { title: "Restore backup", kind: "info", okLabel: "Restore" },
    );
    if (!ok) return;
    busy = "restore";
    bprog = null;
    try {
      await flushSaves();
      pauseSaves(); // nothing may overwrite the restored files before the restart
      const r = await invoke<{ tracks: number; skipped: number }>("backup_restore", { zip, musicDest });
      ui.toast(`Restored ${r.tracks} songs${r.skipped ? ` (${r.skipped} skipped)` : ""}. Restarting…`, "success");
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      busy = null;
      bprog = null;
      // Saves were paused, so the app restarts; show why first (a toast would vanish).
      await message(`The backup couldn't be restored:\n\n${e instanceof Error ? e.message : String(e)}`, {
        title: "Restore didn't work",
        kind: "error",
      }).catch(() => {});
      location.reload();
    }
  }

  const bpct = $derived(bprog?.total ? Math.round((bprog.done / bprog.total) * 100) : null);

  const pct = $derived(tools.progress?.total ? Math.round((tools.progress.done / tools.progress.total) * 100) : null);
</script>

<div class="page narrow">
  <h1 class="page-title">Settings</h1>

  <section class="card">
    <header><Icon name="output" size={20} /><h2>Audio output</h2></header>
    <p class="muted lead">Where the music plays. Previews use it too.</p>
    <OutputPicker />
  </section>

  <section class="card">
    <header><Icon name="download" size={20} /><h2>Downloads</h2></header>
    <span class="lbl">Save songs to</span>
    <div class="pathrow">
      <span class="path" title={settings.value.downloadFolder}>{settings.value.downloadFolder ? prettyPath(settings.value.downloadFolder) : `${defaultFolderLabel} (${isAndroid ? "set" : "chosen"} on first download)`}</span>
      {#if !isAndroid}<button class="btn" onclick={chooseDownloadFolder}><Icon name="folder" size={15} /> Change</button>{/if}
    </div>

    {#if isAndroid}
      <span class="lbl">Quality</span>
      <div class="seg two" role="radiogroup" aria-label="Quality">
        {#each phoneQualities as q}
          <button role="radio" aria-checked={settings.value.quality === q.v} class:on={settings.value.quality === q.v} onclick={() => settings.set("quality", q.v)}>
            <strong>{q.label}</strong><small>{q.note}</small>
          </button>
        {/each}
      </div>
      <p class="note">
        Songs are saved as the site sends them, without converting: YouTube as M4A (AAC), SoundCloud as MP3. <strong>Space saver</strong> picks
        YouTube's smallest stream: about a third of the size, fine for headphones and the car, a little less detailed on a good speaker.
        SoundCloud songs are the same either way. Cover art and tags are added like on the PC, and songs go to the Download/Aurora folder
        (Files app, or a PC over USB).
      </p>
    {:else}
    <span class="lbl">Quality</span>
    <div class="seg" role="radiogroup" aria-label="Quality">
      {#each qualities as q}
        <button role="radio" aria-checked={settings.value.quality === q.v} class:on={settings.value.quality === q.v} onclick={() => settings.set("quality", q.v)}>
          <strong>{q.label}</strong><small>{q.note}</small>
        </button>
      {/each}
    </div>
    <p class="note">
      YouTube audio tops out around 160 kbps Opus, so higher MP3 bitrates add size, not detail. <strong>Space saver</strong> keeps that original stream
      untouched instead of converting it (no quality loss, roughly half the size of Best MP3); the files are <code>.opus</code> (SoundCloud:
      whatever it serves), which Aurora, phones, VLC and foobar2000 play, but some older car stereos and iTunes don't. Cover art and tags are
      embedded either way.
    </p>
    {/if}
  </section>

  {#if !isAndroid}
  <section class="card">
    <header>
      <Icon name="settings" size={20} /><h2>Download tools</h2>
      <span class="state" class:on={tools.status?.ready}>{tools.status?.ready ? "Ready" : "Not installed"}</span>
    </header>
    <dl class="tools">
      <dt>yt-dlp</dt>
      <dd>{tools.status?.ytdlpVersion ?? "missing"}</dd>
      <dt>FFmpeg</dt>
      <dd>{tools.status?.ffmpeg ? "installed" : "missing"}</dd>
      <dt>JavaScript runtime</dt>
      <dd>{tools.status?.jsRuntime ?? "missing"}</dd>
    </dl>
    {#if tools.installing || tools.updating}
      <p class="muted">Downloading {tools.progress?.step ?? "…"} {pct !== null ? `${pct}%` : ""}</p>
      <div class="rail"><div class="fill" style:transform={`scaleX(${(pct ?? 5) / 100})`}></div></div>
    {/if}
    <div class="row">
      {#if !tools.status?.ready && !isLinux}
        <button class="btn primary" onclick={() => tools.install()} disabled={tools.installing || !tools.status?.canInstall}>
          {tools.installing ? "Installing…" : "Install"}
        </button>
      {/if}
      {#if !isLinux}
      <button class="btn" onclick={() => tools.update()} disabled={!tools.status?.ytdlp || tools.updating || tools.installing}>
        <Icon name="refresh" size={15} /> {tools.updating ? "Updating…" : "Update yt-dlp"}
      </button>
      {/if}
    </div>
    {#if isLinux}
      <p class="note">
        On Linux these come from your package manager. On Arch: <code>sudo pacman -S yt-dlp python-mutagen ffmpeg deno</code>. If searches or downloads
        start failing, update yt-dlp (<code>sudo pacman -Syu</code>) — YouTube changes often and yt-dlp keeps up.
      </p>
    {:else}
    <p class="note">If searches or downloads start failing, update yt-dlp first — YouTube changes often and yt-dlp keeps up.</p>
    {/if}
  </section>
  {/if}

  <section class="card">
    <header><Icon name="folder" size={20} /><h2>Library folders</h2></header>
    {#if library.folders.length}
      <ul class="folders">
        {#each library.folders as f (f)}
          <li>
            <span title={f}>{prettyPath(f)}</span>
            <button class="icon" onclick={() => library.removeFolder(f).catch(ui.error)} aria-label={`Remove ${f}`} title="Remove from library (files stay on disk)">
              <Icon name="trash" size={15} />
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">No folders yet.</p>
    {/if}
    <div class="row">
      {#if !isAndroid}<button class="btn" onclick={addFolder} disabled={library.scanning}><Icon name="plus" size={15} /> Add folder</button>{/if}
      <button class="btn" onclick={() => library.rescan().catch(ui.error)} disabled={library.scanning || !library.folders.length}><Icon name="refresh" size={15} /> Rescan</button>
    </div>
    {#if isAndroid}
      <div class="phone"><PhoneMusic /></div>
    {/if}
  </section>

  <section class="card">
    <header><Icon name="disc" size={20} /><h2>Storage</h2></header>
    <p class="muted lead">
      Your music takes {size(library.totalBytes)}. Songs stay exactly as they are when they play, so nothing here slows playback down.
    </p>
    <span class="lbl">Data limit</span>
    <DataLimit />
    <span class="lbl spaced">Slim down cover art</span>
    <p class="note first">
      Many downloads carry a large picture inside every file (up to a few hundred KB each, repeated in every song of an album). This
      re-saves those pictures at 600 px, which still looks sharp everywhere in Aurora. The sound is not touched: each song is checked to be
      byte-for-byte identical before it replaces the original, and anything that doesn't check out is left as it was.
    </p>
    {#if slimming}
      <p class="muted">Checking songs… {sprog?.total ? `${sprog.done} of ${sprog.total}` : ""}</p>
      <div class="rail"><div class="fill" class:indet={!sprog?.total} style:transform={sprog?.total ? `scaleX(${sprog.done / sprog.total})` : undefined}></div></div>
    {/if}
    <div class="row">
      <button class="btn primary" onclick={slimCovers} disabled={slimming || library.scanning || !slimEstimate?.files}>
        <Icon name="sparkle" size={15} />
        {slimming ? "Slimming…" : slimEstimate?.files ? `Free about ${size(slimEstimate.bytes)} (${slimEstimate.files} songs)` : slimEstimate ? "Covers are already slim" : "Checking…"}
      </button>
    </div>
    {#if !isAndroid}<p class="note">To save the most, choose <strong>Space saver</strong> under Downloads: new songs are then about half the size, with no quality lost.</p>{/if}

    <span class="lbl spaced">Same song more than once</span>
    <label class="toggle">
      <input type="checkbox" checked={settings.value.oneCopy} onchange={(e) => { settings.set("oneCopy", e.currentTarget.checked); library.refresh(); }} />
      <span class="sw"></span>
      <span>Keep one copy of each song</span>
    </label>
    <p class="note first">
      Shows each song once, picking the best copy (highest quality, then the one with album details), and doesn't download a song you
      already have.
    </p>
    {#if library.duplicates.length}
      <div class="row">
        <button class="btn" onclick={removeCopies} disabled={removing || library.scanning}>
          <Icon name="trash" size={15} />
          {removing ? "Removing…" : armed ? (isAndroid ? "Tap again to delete" : "Click again to delete") : `Delete ${dupCount} extra ${dupCount === 1 ? "copy" : "copies"} (${size(dupBytes)})`}
        </button>
      </div>
      <p class="note">Playlists, history and play counts move to the copy that's kept. The deleted files can't be brought back.</p>
    {/if}
  </section>

  <section class="card">
    <header><Icon name="copy" size={20} /><h2>Backup and restore</h2></header>
    <p class="muted lead">
      One zip file with everything: your music, every profile with its picture, playlists and covers, listening time, history
      and settings. Open it with Aurora on another PC or phone to carry on where you left off.
    </p>
    <label class="toggle">
      <input type="checkbox" bind:checked={includeMusic} disabled={!!busy} />
      <span class="sw"></span>
      <span>Include music files{estimate ? ` (${estimate.tracks} songs, ${size(estimate.bytes)})` : ""}</span>
    </label>
    {#if busy}
      <p class="muted">{bprog?.step ?? (busy === "backup" ? "Preparing…" : "Opening backup…")} {bpct !== null && bprog?.total ? `${bpct}%` : ""}</p>
      <div class="rail"><div class="fill" class:indet={!bprog?.total} style:transform={bprog?.total ? `scaleX(${bprog.done / bprog.total})` : undefined}></div></div>
    {/if}
    <div class="row">
      <button class="btn primary" onclick={createBackup} disabled={!!busy}>
        <Icon name="download" size={15} /> {busy === "backup" ? "Creating backup…" : "Create backup"}
      </button>
      <button class="btn" onclick={restoreBackup} disabled={!!busy}>
        <Icon name="refresh" size={15} /> {busy === "restore" ? "Restoring…" : "Restore from backup"}
      </button>
    </div>
    {#if !includeMusic}
      <p class="note">Without music the backup is tiny, but playlists only find their songs again if the same files are in the library on the other PC.</p>
    {/if}
  </section>

  <section class="card">
    <header><Icon name="edit" size={20} /><h2>Appearance</h2></header>
    <span class="lbl">Mode</span>
    <div class="seg three" role="radiogroup" aria-label="Mode">
      {#each [["dark", "Dark"], ["light", "Light"], ["system", systemThemeLabel]] as [v, label]}
        <button role="radio" aria-checked={settings.value.theme === v} class:on={settings.value.theme === v} onclick={() => settings.set("theme", v as "dark")}>
          <span class="swatch {v}"></span><strong>{label}</strong>
        </button>
      {/each}
    </div>

    <span class="lbl">Background</span>
    <div class="seg three" role="radiogroup" aria-label="Background">
      <button role="radio" aria-checked={settings.value.background === "cover"} class:on={settings.value.background === "cover"} onclick={() => settings.set("background", "cover")}>
        <strong>Cover art</strong><small>Blurred art of what's playing</small>
      </button>
      <button
        role="radio"
        aria-checked={settings.value.background === "image"}
        class:on={settings.value.background === "image"}
        onclick={() => (settings.value.wallpaper ? settings.set("background", "image") : theme.chooseWallpaper())}
      >
        <strong>Your image</strong><small>Colours taken from a picture</small>
      </button>
      <button role="radio" aria-checked={settings.value.background === "plain"} class:on={settings.value.background === "plain"} onclick={() => settings.set("background", "plain")}>
        <strong>Plain</strong><small>Calm, no pictures</small>
      </button>
    </div>
    {#if settings.value.wallpaper}
      <div class="wallrow">
        <img class="wallthumb" src={theme.wallpaperSrc} alt="Your theme" />
        <div class="wallinfo">
          <span>Theme image</span>
          {#if settings.value.wallpaperColor}
            <span class="chip" style:background={`rgb(${settings.value.wallpaperColor.join(" ")})`} title="Colour taken from the image"></span>
          {/if}
        </div>
        <button class="btn" onclick={() => theme.chooseWallpaper()}>Change</button>
        <button class="btn" onclick={() => theme.removeWallpaper()}>Remove</button>
      </div>
    {:else}
      <button class="btn pick" onclick={() => theme.chooseWallpaper()}><Icon name="reveal" size={15} /> Choose a theme image…</button>
    {/if}
    <p class="note">While music plays, the accent colour follows the cover art. Aurora keeps its own copy of your image, and it's included in backups.</p>
    <div class="spacer"></div>
    <label class="toggle">
      <input type="checkbox" checked={settings.value.reduceMotion} onchange={(e) => settings.set("reduceMotion", e.currentTarget.checked)} />
      <span class="sw"></span>
      <span>Reduce motion</span>
    </label>
  </section>

  <p class="again"><button class="btn" onclick={() => settings.set("setupDone", false)}><Icon name="sparkle" size={15} /> Run the first-time setup again</button></p>
</div>

<style>
  .narrow {
    max-width: 780px;
  }
  .card {
    padding: 22px 24px;
    margin-bottom: 18px;
    border-radius: var(--r-panel);
    background: rgb(var(--ink-rgb) / 0.04);
    border: 1px solid var(--line);
  }
  .card header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
    color: var(--accent);
  }
  .card h2 {
    font-size: 20px;
    color: var(--ink);
  }
  .state {
    margin-left: auto;
    font-size: 12px;
    padding: 3px 10px;
    border-radius: var(--r-pill);
    color: var(--ink-3);
    border: 1px solid var(--line);
  }
  .state.on {
    color: var(--accent);
    border-color: rgb(var(--accent-rgb) / 0.4);
  }
  .lbl {
    display: block;
    font-size: 13px;
    color: var(--ink-2);
    margin: 4px 0 8px;
  }
  .pathrow {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-bottom: 18px;
  }
  .path {
    flex: 1;
    min-width: 0;
    height: 36px;
    line-height: 36px;
    padding: 0 12px;
    border-radius: 10px;
    background: var(--well);
    border: 1px solid var(--line);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .seg {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;
  }
  .seg.two {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .seg button {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 12px;
    border-radius: 12px;
    text-align: left;
    background: var(--well);
    border: 1px solid var(--line);
    transition:
      border-color var(--t-fast),
      background var(--t-fast);
  }
  .seg button.on {
    border-color: var(--accent);
    background: rgb(var(--accent-rgb) / 0.1);
  }
  .seg small {
    color: var(--ink-3);
    font-size: 12px;
  }
  .note {
    font-size: 13px;
    color: var(--ink-3);
    margin: 14px 0 0;
    max-width: 62ch;
  }
  .tools {
    display: grid;
    grid-template-columns: 160px 1fr;
    gap: 6px 12px;
    margin: 0 0 16px;
  }
  .tools dt {
    color: var(--ink-2);
  }
  .tools dd {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rail {
    height: 4px;
    border-radius: 4px;
    background: rgb(var(--ink-rgb) / 0.1);
    overflow: hidden;
    margin: 6px 0 14px;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transform-origin: left;
    transition: transform 300ms linear;
  }
  .row {
    display: flex;
    gap: 10px;
  }
  .seg.three {
    grid-template-columns: repeat(3, 1fr);
    margin-bottom: 16px;
  }
  .swatch {
    display: inline-block;
    width: 28px;
    height: 18px;
    border-radius: 5px;
    margin-bottom: 4px;
    border: 1px solid var(--line);
  }
  .swatch.dark {
    background: linear-gradient(135deg, #15121c 50%, #2a2436 50%);
  }
  .swatch.light {
    background: linear-gradient(135deg, #ffffff 50%, #e6e1ee 50%);
  }
  .swatch.system {
    background: linear-gradient(135deg, #15121c 50%, #ffffff 50%);
  }
  .wallrow {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .wallthumb {
    width: 96px;
    height: 56px;
    object-fit: cover;
    border-radius: 8px;
    border: 1px solid var(--line);
  }
  .wallinfo {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .chip {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 2px solid var(--night-2);
    box-shadow: 0 0 0 1px var(--line);
  }
  .btn.pick {
    margin-top: 2px;
  }
  .spacer {
    height: 14px;
  }
  :global(html[data-phone]) .card {
    padding: 18px 16px;
  }
  :global(html[data-phone]) .row {
    flex-wrap: wrap;
  }
  :global(html[data-phone]) .row .btn {
    white-space: nowrap;
  }
  .phone {
    margin-top: 14px;
  }
  .again {
    margin: 8px 0 0;
  }
  .lbl.spaced {
    margin-top: 26px;
  }
  .note.first {
    margin: 0 0 12px;
    max-width: 72ch;
  }
  .lead {
    margin: -4px 0 16px;
    max-width: 64ch;
  }
  .fill.indet {
    width: 35%;
    animation: slide 1.2s ease-in-out infinite;
  }
  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(300%);
    }
  }
  .icon {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    color: var(--ink-3);
  }
  .icon:hover {
    color: var(--ink);
    background: rgb(var(--ink-rgb) / 0.08);
  }
  .folders {
    list-style: none;
    padding: 0;
    margin: 0 0 14px;
  }
  .folders li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 6px 10px;
    border-radius: 8px;
    background: var(--well);
    margin-bottom: 6px;
  }
  .folders span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 12px;
    cursor: pointer;
    margin-bottom: 12px;
  }
  .toggle input {
    position: absolute;
    opacity: 0;
  }
  .sw {
    position: relative;
    width: 40px;
    height: 22px;
    border-radius: 22px;
    background: rgb(var(--ink-rgb) / 0.16);
    transition: background var(--t-fast);
    flex: none;
  }
  .sw::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.3);
    transition: transform var(--t-med) var(--ease-spring);
  }
  .toggle input:checked + .sw {
    background: var(--accent);
  }
  .toggle input:checked + .sw::after {
    transform: translateX(18px);
  }
  .toggle input:focus-visible + .sw {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
