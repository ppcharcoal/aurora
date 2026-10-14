import { invoke } from "@tauri-apps/api/core";
import { songKey } from "./match";
import { debouncedSaver, storeGet } from "./store";
import type { CatalogTrack } from "./types";

/**
 * Album covers for songs that have none of their own (files without embedded
 * art, or Last.fm history entries that aren't downloaded): looked up once in
 * the music catalog by artist and title, then remembered on disk.
 */
class CoverLookup {
  /** songKey → cover URL, or "" when the catalog has none. */
  private found = $state<Record<string, string>>({});
  private loaded = false;
  private waiting = new Map<string, { artist: string; title: string }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private save: (v: unknown) => void = () => {};

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    this.save = debouncedSaver("cover-lookup", 1000);
    const saved = await storeGet<Record<string, string>>("cover-lookup").catch(() => null);
    if (saved) this.found = { ...saved, ...this.found };
  }

  /** The cover for this song, if known. Unknown songs are looked up in the background. */
  get(artist: string, title: string): string | undefined {
    if (!artist || !title) return undefined;
    const k = songKey(artist, title);
    const hit = this.found[k];
    if (hit !== undefined) return hit || undefined;
    if (!this.waiting.has(k)) {
      this.waiting.set(k, { artist, title });
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 120);
    }
    return undefined;
  }

  private async flush() {
    await this.load();
    const batch = [...this.waiting].filter(([k]) => this.found[k] === undefined).slice(0, 24);
    this.waiting.clear();
    if (!batch.length) return;
    try {
      const res = await invoke<(CatalogTrack | null)[]>("catalog_match_tracks", { items: batch.map(([, s]) => s) });
      const next = { ...this.found };
      batch.forEach(([k], i) => (next[k] = res[i]?.cover ?? ""));
      this.found = next;
      this.save(next);
    } catch {
      // Offline: try again next time the list is shown.
    }
  }
}

export const covers = new CoverLookup();
