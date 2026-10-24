import { profiles } from "./profiles.svelte";
import { debouncedSaver, storeGet } from "./store";
import { isAndroid, isLinux, systemPicksOutput } from "./platform";

/** "small" is the phone's space saver (smallest stream, about 48 kbps AAC). */
export type Quality = "original" | "best" | "320" | "192" | "128" | "small";

export interface Settings {
  /** Where downloaded MP3s go. Empty = Music\Aurora (asked on first download). */
  downloadFolder: string;
  quality: Quality;
  /** Last visualizer style. */
  vizMode: number;
  volume: number;
  reduceMotion: boolean;
  /** Old switch, kept for migration (now `background`). */
  ambient: boolean;
  /** Old switch, kept for migration (now `searchSource`). */
  verifiedSearch: boolean;
  /** catalog = real songs from a music catalog; youtube / soundcloud = that site directly. */
  searchSource: "catalog" | "youtube" | "soundcloud";
  /** When the best YouTube upload fails, try SoundCloud. */
  soundcloudFallback: boolean;
  theme: "dark" | "light" | "system";
  /** cover = blurred cover art, image = your picture, plain = flat colour */
  background: "cover" | "image" | "plain";
  /** File name in the wallpapers folder. */
  wallpaper?: string;
  wallpaperColor?: [number, number, number];
  /** Most space music may take, in bytes (0 = no limit). Downloads that would go over it wait. */
  dataLimit: number;
  /** Chosen speakers/headphones (null = the system default). `label` lets us find it again if its id changes. */
  audioOutput: { id: string; label: string } | null;
  /** List each song once even if it's in the library several times, and don't download songs you already have. */
  oneCopy: boolean;
  /** The first-time setup has been finished or skipped. */
  setupDone: boolean;
  /** Volume sync: play every song at about the same loudness. */
  volumeSync: boolean;
}

const defaults: Settings = {
  downloadFolder: "",
  quality: "best",
  vizMode: 0,
  volume: 0.8,
  reduceMotion: false,
  ambient: true,
  verifiedSearch: true,
  searchSource: "catalog",
  soundcloudFallback: true,
  theme: "dark",
  background: "cover",
  dataLimit: 0,
  audioOutput: null,
  oneCopy: true,
  setupDone: false,
  volumeSync: false,
};

class SettingsStore {
  value = $state<Settings>({ ...defaults });
  private save: (v: unknown) => void = () => {};

  async load() {
    this.save = debouncedSaver(profiles.key("settings"));
    const saved = await storeGet<Partial<Settings>>(profiles.key("settings"));
    this.value = { ...defaults, ...(saved ?? {}) };
    if (saved && saved.background === undefined && saved.ambient === false) this.value.background = "plain";
    if (saved && saved.searchSource === undefined && saved.verifiedSearch === false) this.value.searchSource = "youtube";
    // Phones save the stream as it comes (no converter on board): best or smallest.
    if (isAndroid) {
      if (this.value.quality !== "small") this.value.quality = "original";
      // Settings restored from a Windows backup: its folders and devices don't exist here.
      if (this.value.downloadFolder && !this.value.downloadFolder.startsWith("/")) this.value.downloadFolder = "";
      if (this.value.audioOutput && !this.value.audioOutput.id.includes("|")) this.value.audioOutput = null;
    } else {
      // Settings restored from another kind of device (a Windows backup on
      // Linux, a phone backup on a PC…): drop what can't work here.
      const f = this.value.downloadFolder;
      const windowsPath = /^[A-Za-z]:[\\/]|^\\\\/.test(f);
      const phonePath = f.startsWith("/storage/") || f.startsWith("/sdcard/") || f.includes("/Android/data/");
      if (f && (isLinux ? windowsPath || phonePath || !f.startsWith("/") : !windowsPath)) this.value.downloadFolder = "";
      if (systemPicksOutput || this.value.audioOutput?.id.includes("|")) this.value.audioOutput = null;
      if (this.value.quality === "small") this.value.quality = "best";
    }
  }

  set<K extends keyof Settings>(key: K, v: Settings[K]) {
    this.value[key] = v;
    this.save($state.snapshot(this.value));
  }
}

export const settings = new SettingsStore();
