import { invoke } from "@tauri-apps/api/core";
import { pickImage } from "./pick";
import { imageSrc } from "./paths";
import { flushSaves, storeGet, storeSet } from "./store";
import { ui } from "./ui.svelte";

export interface Profile {
  id: string;
  name: string;
  /** File name in the avatars folder. */
  avatar?: string;
  created: number;
}

interface ProfilesFile {
  active: string;
  list: Profile[];
}

const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

/** The music library is shared; everything else (settings, playlists, history, stats) is per profile. */
class Profiles {
  list = $state<Profile[]>([]);
  activeId = $state("");
  active = $derived(this.list.find((p) => p.id === this.activeId) ?? this.list[0]);

  /** Store key for this profile's data, e.g. "p-ab12cd-playlists". */
  key(name: string) {
    return `p-${this.activeId}-${name}`;
  }

  avatarSrc(p?: Profile) {
    return imageSrc("avatar", p?.avatar);
  }

  async load() {
    const file = await storeGet<ProfilesFile>("profiles");
    if (file?.list?.length) {
      this.list = file.list;
      this.activeId = file.list.some((p) => p.id === file.active) ? file.active : file.list[0].id;
      return;
    }
    // First run, or upgrading from a version without profiles: move the
    // existing settings and playlists into a first profile.
    const id = uid();
    this.list = [{ id, name: "Me", created: Date.now() }];
    this.activeId = id;
    for (const name of ["settings", "playlists"]) {
      const legacy = await storeGet<unknown>(name);
      if (legacy != null) {
        await storeSet(`p-${id}-${name}`, legacy);
        await storeSet(name, null);
      }
    }
    try {
      const recent = JSON.parse(localStorage.getItem("aurora.recent") ?? "null");
      if (Array.isArray(recent)) await storeSet(`p-${id}-recent`, recent);
      localStorage.removeItem("aurora.recent");
    } catch {
      /* ignore */
    }
    await this.save();
  }

  private save() {
    return storeSet("profiles", $state.snapshot({ active: this.activeId, list: this.list }));
  }

  async create(name: string): Promise<string> {
    const p: Profile = { id: uid(), name: name.trim() || "New profile", created: Date.now() };
    this.list.push(p);
    await this.save();
    return p.id;
  }

  async rename(id: string, name: string) {
    const p = this.list.find((x) => x.id === id);
    if (!p || !name.trim()) return;
    p.name = name.trim();
    await this.save();
  }

  async chooseAvatar(id: string) {
    const p = this.list.find((x) => x.id === id);
    if (!p) return;
    const file = await pickImage("Choose a profile picture");
    if (!file) return;
    try {
      p.avatar = await invoke<string>("image_store", { kind: "avatar", owner: p.id, source: file });
      await this.save();
    } catch (e) {
      ui.error(e);
    }
  }

  /** Name and picture from Last.fm (the picture is copied into Aurora). */
  async applyLastfm(id: string, name: string, imageUrl?: string) {
    const p = this.list.find((x) => x.id === id);
    if (!p) return;
    if (name.trim()) p.name = name.trim();
    if (imageUrl) {
      try {
        p.avatar = await invoke<string>("image_store_url", { kind: "avatar", owner: p.id, url: imageUrl });
      } catch (e) {
        ui.error(e);
      }
    }
    await this.save();
  }

  async removeAvatar(id: string) {
    const p = this.list.find((x) => x.id === id);
    if (!p?.avatar) return;
    invoke("image_remove", { kind: "avatar", name: p.avatar }).catch(() => {});
    p.avatar = undefined;
    await this.save();
  }

  /** Switching reloads the window so every view starts clean with the new profile's data. */
  async switchTo(id: string) {
    if (id === this.activeId) return;
    await flushSaves();
    this.activeId = id;
    await this.save();
    location.reload();
  }

  async remove(id: string) {
    if (this.list.length <= 1) return;
    const p = this.list.find((x) => x.id === id);
    if (p?.avatar) invoke("image_remove", { kind: "avatar", name: p.avatar }).catch(() => {});
    const theirs = await storeGet<{ wallpaper?: string }>(`p-${id}-settings`);
    if (theirs?.wallpaper) invoke("image_remove", { kind: "wallpaper", name: theirs.wallpaper }).catch(() => {});
    for (const name of ["settings", "playlists", "stats", "recent", "transitions"]) await storeSet(`p-${id}-${name}`, null);
    this.list = this.list.filter((x) => x.id !== id);
    if (this.activeId === id) {
      this.activeId = this.list[0].id;
      await this.save();
      location.reload();
      return;
    }
    await this.save();
  }
}

export const profiles = new Profiles();
