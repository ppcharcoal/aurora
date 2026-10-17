import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Album, Track } from "../types";
import { native } from "../native";
import { songKey } from "../match";
import { settings } from "../settings.svelte";
import { isAndroid } from "../platform";

interface RawTrack {
  id: string;
  path: string;
  title: string;
  artist: string;
  album: string;
  albumArtist?: string | null;
  albumTagged?: boolean;
  trackNo?: number | null;
  discNo?: number | null;
  year?: number | null;
  durationMs: number;
  size?: number;
  cover?: string | null;
  color?: [number, number, number] | null;
}
interface RawIndex {
  version?: number;
  folders: string[];
  tracks: RawTrack[];
}

function toTrack(t: RawTrack): Track {
  return {
    key: t.id,
    id: t.id,
    path: t.path,
    title: t.title,
    artist: t.artist,
    album: t.albumTagged ? t.album : undefined,
    durationMs: t.durationMs,
    size: t.size,
    art: t.cover ? convertFileSrc(t.cover) : undefined,
    coverPath: t.cover ?? undefined,
    color: t.color ?? undefined,
  };
}

export const normPath = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

class LocalLibrary {
  folders = $state<string[]>([]);
  // Large arrays are stored raw (not deeply proxied) — much cheaper.
  tracks = $state.raw<Track[]>([]);
  albums = $state.raw<Album[]>([]);
  byId = $state.raw(new Map<string, Track>());
  /** Songs that are in the library more than once, best copy first. */
  duplicates = $state.raw<Track[][]>([]);
  private songs = new Map<string, Track>();
  scanning = $state(false);
  /** Total size of all songs in the library, in bytes. */
  totalBytes = $state(0);
  progress = $state({ done: 0, total: 0 });
  private meta = new Map<string, RawTrack>();
  private last: RawIndex = { folders: [], tracks: [] };
  /** Picture source for songs without artwork (the downloads module sets it: YouTube thumbnails). */
  private sourceArt: () => (path: string) => string | undefined = () => () => undefined;

  setSourceArt(f: () => (path: string) => string | undefined) {
    this.sourceArt = f;
    if (this.last.tracks.length) this.apply(this.last);
  }
  private byPath = new Map<string, Track>();

  async init() {
    await listen<{ done: number; total: number }>("library://progress", (e) => {
      this.progress = e.payload;
    });
    const idx = await invoke<RawIndex>("library_get");
    this.apply(idx);
    // Library cached by an older version: re-read tags once in the background.
    if ((idx.version ?? 0) < 4 && idx.folders.length) this.rescan().catch(() => {});
  }

  private apply(idx: RawIndex) {
    this.folders = idx.folders;
    this.meta = new Map(idx.tracks.map((t) => [t.id, t]));
    this.totalBytes = idx.tracks.reduce((sum, t) => sum + (t.size ?? 0), 0);
    const all = idx.tracks.map(toTrack);
    this.byPath = new Map(all.map((t) => [normPath(t.path), t]));

    // Same song more than once (e.g. downloaded on the phone and restored from
    // a PC backup): group the copies. With "keep one copy" on, only the best
    // copy is listed, and links to the others (playlists, history) open it.
    const groups = new Map<string, Track[]>();
    for (const t of all) {
      const k = songKey(t.artist, t.title);
      const g = groups.get(k);
      const near = g?.find((x) => !x.durationMs || !t.durationMs || Math.abs(x.durationMs - t.durationMs) < 6000);
      if (g && near) g.push(t);
      else if (!g) groups.set(k, [t]);
      else groups.set(`${k}\u0002${t.id}`, [t]);
    }
    this.songs = new Map();
    const dupes: Track[][] = [];
    const replaced = new Map<string, Track>();
    for (const [k, g] of groups) {
      const sorted = g.length > 1 ? [...g].sort((a, b) => this.quality(b) - this.quality(a)) : g;
      this.songs.set(k.split("\u0002")[0], sorted[0]);
      if (sorted.length > 1) {
        dupes.push(sorted);
        if (settings.value.oneCopy) for (const t of sorted.slice(1)) replaced.set(t.id, sorted[0]);
      }
    }
    this.duplicates = dupes;
    const tracks = replaced.size ? all.filter((t) => !replaced.has(t.id)) : all;
    this.tracks = tracks;
    this.byId = new Map(all.map((t) => [t.id, replaced.get(t.id) ?? t]));
    this.albums = this.buildAlbums();
    // Songs without their own artwork borrow the album's, else their YouTube thumbnail.
    for (const a of this.albums) for (const t of a.tracks) t.art ??= a.art;
    const art = this.sourceArt();
    for (const t of all) t.art ??= art(t.path);
    this.last = idx;
    // Android Auto's lists come from the same files; tell it to refresh.
    if (isAndroid) native.call("reload").catch(() => {});
  }

  /** Best copy first: higher bitrate, then part of an album. */
  private quality(t: Track): number {
    const m = this.meta.get(t.id);
    const kbps = t.durationMs && t.size ? (t.size * 8) / t.durationMs : 0;
    return kbps + (m?.albumTagged ? 1 : 0) + (m?.cover ? 0.5 : 0);
  }

  /** Re-list after "keep one copy" changes. */
  refresh() {
    if (this.last.tracks.length || this.last.folders.length) this.apply(this.last);
  }

  /** A song already in the library (same artist and title, similar length), if any. */
  findSong(artist: string, title: string, durationMs?: number): Track | undefined {
    const t = this.songs.get(songKey(artist, title));
    if (!t) return undefined;
    if (durationMs && t.durationMs && Math.abs(durationMs - t.durationMs) > 8000) return undefined;
    return t;
  }

  trackAt(path: string): Track | undefined {
    return this.byPath.get(normPath(path));
  }

  /** True if `folder` is already inside one of the library folders. */
  covers(folder: string): boolean {
    const f = normPath(folder);
    return this.folders.some((x) => f === normPath(x) || f.startsWith(normPath(x) + "\\"));
  }

  private buildAlbums(): Album[] {
    // Only songs with a real album tag form albums. Untagged files (e.g. single
    // downloads) are standalone songs and live in the Songs tab.
    const groups = new Map<string, Track[]>();
    for (const t of this.tracks) {
      const m = this.meta.get(t.id)!;
      if (!m.albumTagged) continue;
      const key = `${(m.albumArtist ?? m.artist).toLowerCase()}\u0001${m.album.toLowerCase()}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(t);
    }
    const out: Album[] = [];
    for (const [key, tracks] of groups) {
      const m = this.meta.get(tracks[0].id)!;
      tracks.sort((a, b) => {
        const ma = this.meta.get(a.id)!;
        const mb = this.meta.get(b.id)!;
        return (ma.discNo ?? 0) - (mb.discNo ?? 0) || (ma.trackNo ?? 0) - (mb.trackNo ?? 0);
      });
      out.push({
        id: key,
        name: m.album,
        subtitle: [m.albumArtist ?? m.artist, m.year].filter(Boolean).join(", "),
        art: tracks.find((t) => t.art)?.art,
        tracks,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async run(cmd: string, args?: Record<string, unknown>) {
    this.scanning = true;
    this.progress = { done: 0, total: 0 };
    try {
      this.apply(await invoke<RawIndex>(cmd, args));
    } finally {
      this.scanning = false;
    }
  }

  addFolder = (path: string) => this.run("library_add_folder", { path });
  removeFolder = (path: string) => this.run("library_remove_folder", { path });
  rescan = () => this.run("library_rescan");
  /** Deletes the extra copies (keeps the best one). Playlists, history and stats move to the kept copy. */
  removeCopies = () => {
    const pairs = this.duplicates.flatMap((g) => g.slice(1).map((t) => [t.path, g[0].path] as [string, string]));
    return this.run("library_remove_copies", { pairs }).then(() => pairs.length);
  };

  /** Adds specific new files (finished downloads) without a full rescan. */
  async importFiles(paths: string[]) {
    this.apply(await invoke<RawIndex>("library_import", { paths }));
  }
}

export const library = new LocalLibrary();
