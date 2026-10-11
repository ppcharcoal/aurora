import { invoke } from "@tauri-apps/api/core";
import { pickImage } from "./pick";
import { fileName, imageSrc } from "./paths";
import { profiles } from "./profiles.svelte";
import { library } from "./sources/local.svelte";
import { debouncedSaver, storeGet } from "./store";
import type { Playlist, Track } from "./types";
import { ui } from "./ui.svelte";
import { native } from "./native";
import { isAndroid } from "./platform";

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

class Playlists {
  list = $state<Playlist[]>([]);
  private save: (v: unknown) => void = () => {};
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  async load() {
    this.save = debouncedSaver(profiles.key("playlists"), 250);
    const list = (await storeGet<Playlist[]>(profiles.key("playlists"))) ?? [];
    // Older versions stored the cover's full path; keep just the file name.
    for (const p of list) if (p.cover) p.cover = fileName(p.cover);
    this.list = list;
  }

  private persist() {
    this.save($state.snapshot(this.list));
    // Android Auto reads the saved file; refresh it once it's written.
    if (isAndroid) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => native.call("reload").catch(() => {}), 800);
    }
  }

  get(id: string) {
    return this.list.find((p) => p.id === id);
  }

  /** Resolves ids to tracks, skipping files that are no longer in the library. */
  tracks(p: Playlist): Track[] {
    const out: Track[] = [];
    for (const id of p.trackIds) {
      const t = library.byId.get(id);
      // A hidden duplicate copy resolves to the kept one: don't list that song twice.
      if (t && !(t.id !== id && out.includes(t))) out.push(t);
    }
    return out;
  }

  /** A custom cover, or up to four distinct song covers for the mosaic. */
  covers(p: Playlist): string[] {
    if (p.cover) return [imageSrc("playlist", p.cover)!];
    const seen = new Set<string>();
    for (const id of p.trackIds) {
      const art = library.byId.get(id)?.art;
      if (art && !seen.has(art)) seen.add(art);
      if (seen.size === 4) break;
    }
    return [...seen];
  }

  create(name: string, trackIds: string[] = []): string {
    const now = Date.now();
    const p: Playlist = { id: uid(), name: name.trim() || "New playlist", trackIds, created: now, updated: now };
    this.list.push(p);
    this.persist();
    return p.id;
  }

  rename(id: string, name: string) {
    const p = this.get(id);
    if (!p || !name.trim()) return;
    p.name = name.trim();
    p.updated = Date.now();
    this.persist();
  }

  remove(id: string) {
    const p = this.get(id);
    if (p?.cover) invoke("image_remove", { kind: "playlist", name: p.cover }).catch(() => {});
    this.list = this.list.filter((p) => p.id !== id);
    this.persist();
  }

  /** Lets you pick an image on your PC; Aurora keeps its own copy. */
  async chooseCover(id: string) {
    const p = this.get(id);
    if (!p) return;
    const file = await pickImage("Choose a cover image");
    if (!file) return;
    try {
      p.cover = await invoke<string>("image_store", { kind: "playlist", owner: p.id, source: file });
      p.updated = Date.now();
      this.persist();
      ui.toast("Cover updated", "success", 2000);
    } catch (e) {
      ui.error(e);
    }
  }

  removeCover(id: string) {
    const p = this.get(id);
    if (!p?.cover) return;
    invoke("image_remove", { kind: "playlist", name: p.cover }).catch(() => {});
    p.cover = undefined;
    p.updated = Date.now();
    this.persist();
  }

  add(id: string, trackIds: string[]) {
    const p = this.get(id);
    if (!p) return;
    const fresh = trackIds.filter((t) => !p.trackIds.includes(t));
    if (!fresh.length) {
      ui.toast(`Already in “${p.name}”`);
      return;
    }
    p.trackIds.push(...fresh);
    p.updated = Date.now();
    this.persist();
    ui.toast(
      fresh.length === 1 ? `Added to “${p.name}”` : `Added ${fresh.length} songs to “${p.name}”`,
      "success",
      2200,
    );
  }

  removeTrack(id: string, index: number) {
    const p = this.get(id);
    if (!p) return;
    p.trackIds.splice(index, 1);
    p.updated = Date.now();
    this.persist();
  }

  move(id: string, from: number, to: number) {
    const p = this.get(id);
    if (!p || from === to) return;
    const [x] = p.trackIds.splice(from, 1);
    p.trackIds.splice(to, 0, x);
    p.updated = Date.now();
    this.persist();
  }

  /** Asks for a name, creates the playlist, optionally with songs in it. */
  async createInteractive(trackIds: string[] = []) {
    const name = await ui.prompt("New playlist", "Playlist name", `My playlist ${this.list.length + 1}`);
    if (name === null) return null;
    const id = this.create(name, trackIds);
    if (trackIds.length) ui.toast(`Created “${this.get(id)!.name}”`, "success", 2200);
    return id;
  }
}

export const playlists = new Playlists();
