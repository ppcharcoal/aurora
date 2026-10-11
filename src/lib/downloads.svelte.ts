import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { player } from "./player.svelte";
import { playlists } from "./playlists.svelte";
import { settings } from "./settings.svelte";
import { library, normPath } from "./sources/local.svelte";
import { debouncedSaver, storeGet } from "./store";
import { tools } from "./tools.svelte";
import type { AlbumResult, CatalogTrack, DownloadItem, SearchResult } from "./types";
import { ui } from "./ui.svelte";
import { defaultMusicFolder, isOldPhoneDefault, native, prettyPath } from "./native";
import { isAndroid } from "./platform";

type Progress = { id: string; percent: number; speed: string; eta: string };
import { splitTitle, thumb } from "./ytparse";
import { bytes, estimateBytes } from "./format";
import { AVG_SONG_MS } from "./limit";

/** Two at a time keeps YouTube happy and the machine responsive. An album counts as one. */
const CONCURRENCY = 2;

const isActive = (i: DownloadItem) => i.status === "queued" || i.status === "downloading" || i.status === "converting";

class Downloads {
  items = $state<DownloadItem[]>([]);
  /** videoId → file path, so search results can show "Downloaded". Shared by all profiles. */
  done = $state<Record<string, string>>({});
  active = $derived(this.items.filter(isActive).length);
  private saveDone = debouncedSaver("downloaded", 300);
  private canceled = new Set<string>();

  async init() {
    this.done = (await storeGet<Record<string, string>>("downloaded")) ?? {};
    library.setSourceArt(() => {
      const byPath = new Map<string, string>();
      for (const [id, p] of Object.entries(this.done)) if (/^[\w-]{11}$/.test(id)) byPath.set(normPath(p), id);
      return (path) => {
        const id = byPath.get(normPath(path));
        return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : undefined;
      };
    });
    await listen<{ id: string; attempt: number; of: number }>("download://retry", (e) => {
      for (const it of this.items) {
        if (it.id === e.payload.id || it.currentVideo === e.payload.id) it.retry = `Retrying (${e.payload.attempt} of ${e.payload.of})`;
      }
    });
    await listen<Progress>("download://progress", (e) => this.progress(e.payload));
    // Phone version: progress comes from the Android side.
    if (isAndroid) await native.on<Progress>("progress", (p) => this.progress(p)).catch(() => {});
  }

  private progress(p: Progress) {
    {
      const { id, percent, speed, eta } = p;
      for (const it of this.items) {
        if (it.status !== "downloading" && it.status !== "converting") continue;
        if (it.kind === "song" && (it.id === id || it.currentVideo === id)) {
          it.percent = percent;
          it.status = percent >= 100 ? "converting" : "downloading";
        } else if (it.kind === "album" && it.currentVideo === id) {
          const total = it.album!.tracks.length;
          it.percent = (((it.completed ?? 0) + (it.failed ?? 0) + percent / 100) / total) * 100;
        } else continue;
        it.speed = speed;
        it.eta = eta;
      }
    }
  }

  /**
   * The library's copy of a download: by the video/catalog id it was
   * downloaded from, or (with "keep one copy" on) any song with the same
   * artist, title and length, wherever it came from.
   */
  trackFor(videoId: string, song?: { artist?: string; title: string; durationMs?: number }) {
    const p = this.done[videoId];
    const t = p ? library.trackAt(p) : undefined;
    if (t) return library.byId.get(t.id) ?? t;
    if (song?.artist && settings.value.oneCopy) return library.findSong(song.artist, song.title, song.durationMs);
    return undefined;
  }

  status(id: string): DownloadItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  albumStatus(a: AlbumResult) {
    return this.status(`album:${a.id}`);
  }

  /** How many of an album's tracks are already in the library. */
  albumHave(a: AlbumResult) {
    return a.tracks.filter((t) => this.trackFor(t.id, { artist: t.artist ?? a.artist, title: t.title, durationMs: t.durationMs })).length;
  }

  private async prepare(): Promise<boolean> {
    if (!(await tools.ensure())) return false;
    const old = settings.value.downloadFolder;
    // Phones: move off the first default (hidden in Android/data) to Download/Aurora.
    // Songs already there stay in the library.
    if (old && !(isAndroid && isOldPhoneDefault(old))) return true;
    try {
      const dir = await defaultMusicFolder();
      settings.set("downloadFolder", dir);
      if (dir !== old) ui.toast(`Saving downloads to ${prettyPath(dir)}.${isAndroid ? "" : " You can change this in Settings."}`, "info", 6000);
      return true;
    } catch (e) {
      ui.error(e);
      return false;
    }
  }

  async enqueue(r: SearchResult, playlistId?: string) {
    const split = splitTitle(r.title, r.channel);
    const existing = this.trackFor(r.id, { artist: split.artist, title: split.title, durationMs: r.durationMs });
    if (existing) {
      if (playlistId) playlists.add(playlistId, [existing.id]);
      else ui.toast(`Already in your library: “${existing.title}”`);
      return;
    }
    const cur = this.status(r.id);
    if (cur && isActive(cur)) {
      if (playlistId) cur.playlistId = playlistId;
      return;
    }
    if (!(await this.prepare())) return;

    const { title, artist } = splitTitle(r.title, r.channel);
    this.items = [
      {
        id: r.id,
        kind: "song",
        title,
        artist,
        thumb: r.thumb ?? thumb(r.id),
        durationMs: r.durationMs,
        status: "queued",
        percent: 0,
        speed: "",
        eta: "",
        playlistId,
      },
      ...this.items.filter((i) => i.id !== r.id),
    ];
    this.pump();
  }

  /** A song from the music catalog: Aurora finds the matching YouTube upload itself. */
  async enqueueCatalog(t: CatalogTrack, playlistId?: string, opts: { thenQueue?: boolean; quiet?: boolean } = {}) {
    const existing = this.trackFor(t.id, t);
    if (existing) {
      if (playlistId) playlists.add(playlistId, [existing.id]);
      else if (opts.thenQueue) player.addToQueue(existing, true);
      else if (!opts.quiet) ui.toast(`Already in your library: “${existing.title}”`);
      return;
    }
    const cur = this.status(t.id);
    if (cur && isActive(cur)) {
      if (playlistId) cur.playlistId = playlistId;
      return;
    }
    if (!(await this.prepare())) return;
    this.canceled.delete(t.id);
    this.items = [
      {
        id: t.id,
        kind: "song",
        title: t.title,
        artist: t.artist,
        thumb: t.cover ?? "",
        durationMs: t.durationMs,
        status: "queued",
        percent: 0,
        speed: "",
        eta: "",
        playlistId,
        catalog: t,
        thenQueue: opts.thenQueue,
      },
      ...this.items.filter((i) => i.id !== t.id),
    ];
    this.pump();
  }

  /** Catalog ids ("dz:…", "it:…") need a YouTube source first. */
  /**
   * Downloads one song, trying sources in order: for catalog songs the best
   * YouTube uploads (up to 3), then SoundCloud. Each attempt already retries
   * temporary errors (like 403) inside yt-dlp's runner.
   */
  private async fetchSong(
    item: DownloadItem,
    song: { id: string; artist: string; title: string; durationMs: number },
    folder: string,
    tags: Record<string, unknown> | null,
  ): Promise<{ path: string; videoId: string }> {
    const isCatalog = /^(dz|it):/.test(song.id);
    const sites: ("youtube" | "soundcloud")[] = isCatalog
      ? settings.value.soundcloudFallback
        ? ["youtube", "soundcloud"]
        : ["youtube"]
      : ["youtube"];
    let lastError: unknown = null;
    for (const site of sites) {
      let candidates: string[] = [song.id];
      if (isCatalog) {
        if (item.kind === "song") item.current = site === "youtube" ? "Finding the best match" : "Trying SoundCloud";
        try {
          candidates = await invoke<string[]>("yt_find_source", { artist: song.artist, title: song.title, durationMs: song.durationMs, site });
        } catch (e) {
          lastError = e;
          continue;
        }
        if (item.kind === "song") item.current = undefined;
      }
      for (const videoId of candidates) {
        if (this.canceled.has(item.id)) throw "canceled";
        item.currentVideo = videoId;
        item.retry = undefined;
        try {
          const path = await invoke<string>("yt_download", { id: videoId, folder, quality: settings.value.quality, tags });
          return { path, videoId };
        } catch (e) {
          if (String(e) === "canceled") throw e;
          lastError = e;
        }
      }
    }
    throw lastError ?? "Download failed.";
  }

  async enqueueAlbum(a: AlbumResult) {
    const id = `album:${a.id}`;
    const cur = this.status(id);
    if (cur && isActive(cur)) return;
    if (!(await this.prepare())) return;
    this.canceled.delete(id);
    this.items = [
      {
        id,
        kind: "album",
        title: a.title,
        artist: a.artist,
        thumb: a.thumb ?? thumb(a.tracks[0].id),
        durationMs: a.tracks.reduce((s, t) => s + t.durationMs, 0),
        status: "queued",
        percent: 0,
        speed: "",
        eta: "",
        album: a,
        completed: 0,
        failed: 0,
        paths: [],
      },
      ...this.items.filter((i) => i.id !== id),
    ];
    this.pump();
  }

  /** Estimated bytes a download will still add to the library. */
  private need(it: DownloadItem) {
    const q = settings.value.quality;
    if (it.kind === "album" && it.album) {
      return it.album.tracks.filter((t) => !this.trackFor(t.id)).reduce((s, t) => s + estimateBytes(t.durationMs || AVG_SONG_MS, q), 0);
    }
    return estimateBytes(it.durationMs || AVG_SONG_MS, q);
  }

  private pump() {
    const running = this.items.filter((i) => i.status === "downloading" || i.status === "converting");
    let free = CONCURRENCY - running.length;
    // Data limit: what's on disk + what's downloading now + this one must fit.
    const limit = settings.value.dataLimit;
    let planned = library.totalBytes + running.reduce((s, i) => s + this.need(i), 0);
    let blocked = 0;
    for (const it of [...this.items].reverse().filter((i) => i.status === "queued")) {
      if (free <= 0) break;
      const need = this.need(it);
      if (limit && planned + need > limit) {
        it.status = "error";
        it.error = `Over your ${bytes(limit)} data limit (needs about ${bytes(need)}, ${bytes(Math.max(0, limit - planned))} left). Raise it in Settings → Storage or free up space, then retry.`;
        blocked++;
        continue;
      }
      planned += need;
      free--;
      if (it.kind === "album") this.runAlbum(it);
      else this.runSong(it);
    }
    if (blocked) ui.toast(`Data limit reached: ${blocked === 1 ? "a download was" : `${blocked} downloads were`} held back. Raise the limit in Settings → Storage.`, "error", 7000);
  }

  /** Makes sure the download folder is in the library, then adds the new files. */
  private async addToLibrary(folder: string, paths: string[]) {
    if (!paths.length) return;
    if (!library.covers(folder)) await library.addFolder(folder);
    else await library.importFiles(paths);
  }

  private remember(videoId: string, path: string) {
    this.done[videoId] = path;
    this.saveDone($state.snapshot(this.done));
  }

  private async runSong(it: DownloadItem) {
    const item = this.items.find((i) => i.id === it.id)!;
    item.status = "downloading";
    item.error = undefined;
    this.canceled.delete(item.id);
    const folder = settings.value.downloadFolder;
    const c = item.catalog;
    try {
      const { path, videoId } = await this.fetchSong(
        item,
        c ? { id: c.id, artist: c.artist, title: c.title, durationMs: c.durationMs } : { id: item.id, artist: item.artist, title: item.title, durationMs: item.durationMs },
        folder,
        c ? { title: c.title, artist: c.artist, year: c.year ?? null, coverUrl: c.cover ?? null } : null,
      );
      item.current = undefined;
      item.retry = undefined;
      item.path = path;
      item.percent = 100;
      this.remember(videoId, path);
      if (c) this.remember(c.id, path);
      await this.addToLibrary(folder, [path]);
      item.status = "done";
      const t = library.trackAt(path);
      if (t && item.playlistId) playlists.add(item.playlistId, [t.id]);
      if (t && item.thenQueue) player.addToQueue(t, true);
    } catch (e) {
      const msg = String(e);
      if (msg === "canceled" || this.canceled.has(item.id)) item.status = "canceled";
      else {
        item.status = "error";
        item.error = msg;
      }
    } finally {
      this.pump();
    }
  }

  private async runAlbum(it: DownloadItem) {
    const item = this.items.find((i) => i.id === it.id)!;
    const a = item.album!;
    item.status = "downloading";
    item.error = undefined;
    item.completed = 0;
    item.failed = 0;
    item.paths = [];
    const folder = settings.value.downloadFolder;
    const errors: string[] = [];

    for (let i = 0; i < a.tracks.length; i++) {
      if (this.canceled.has(item.id)) break;
      const t = a.tracks[i];
      item.current = t.title;
      item.currentVideo = t.id;
      // Already have this song (here or as a single): don't download it again.
      const owned = this.trackFor(t.id, { artist: t.artist ?? a.artist, title: t.title, durationMs: t.durationMs });
      if (owned) {
        this.remember(t.id, owned.path);
        item.completed!++;
        item.percent = ((item.completed! + item.failed!) / a.tracks.length) * 100;
        continue;
      }
      try {
        const artist = t.artist ?? a.artist;
        const { path, videoId } = await this.fetchSong(item, { id: t.id, artist, title: t.title, durationMs: t.durationMs }, folder, {
            title: t.title,
            artist,
            album: a.title,
            albumArtist: a.artist,
            trackNo: i + 1,
            trackTotal: a.tracks.length,
            year: a.year ?? null,
            coverUrl: a.thumb ?? null,
        });
        item.current = t.title;
        item.paths!.push(path);
        item.completed!++;
        this.remember(t.id, path);
        if (videoId !== t.id) this.remember(videoId, path);
      } catch (e) {
        if (String(e) === "canceled") break;
        item.failed!++;
        errors.push(`${t.title}: ${e}`);
      }
      item.percent = ((item.completed! + item.failed!) / a.tracks.length) * 100;
    }

    item.current = undefined;
    item.currentVideo = undefined;
    try {
      await this.addToLibrary(folder, item.paths!);
    } catch (e) {
      ui.error(e);
    }
    if (this.canceled.has(item.id)) {
      item.status = "canceled";
    } else if (!item.completed) {
      item.status = "error";
      item.error = errors[0] ?? "No tracks could be downloaded.";
    } else {
      item.status = "done";
      item.percent = 100;
      if (item.failed) item.error = `${item.failed} of ${a.tracks.length} tracks failed. ${errors[0] ?? ""}`;
      ui.toast(`“${a.title}” is in your library`, "success");
    }
    this.pump();
  }

  cancel(id: string) {
    const it = this.status(id);
    if (!it) return;
    if (it.status === "queued") {
      it.status = "canceled";
      return;
    }
    if (it.kind === "album") {
      this.canceled.add(id);
      if (it.currentVideo) invoke("yt_cancel", { id: it.currentVideo }).catch(ui.error);
    } else {
      this.canceled.add(id);
      invoke("yt_cancel", { id: it.currentVideo ?? id }).catch(ui.error);
    }
  }

  retry(id: string) {
    const it = this.status(id);
    if (!it) return;
    this.canceled.delete(id);
    it.status = "queued";
    it.percent = 0;
    it.error = undefined;
    this.pump();
  }

  clearFinished() {
    this.items = this.items.filter(isActive);
  }
}

export const downloads = new Downloads();
