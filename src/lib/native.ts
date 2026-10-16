import { addPluginListener, invoke, type PluginListener } from "@tauri-apps/api/core";

/**
 * The Android side of Aurora (src-tauri/aurora-mobile/android): native
 * playback service (background play, lock screen, Android Auto), audio
 * outputs and downloads. Only used on Android.
 */
const PLUGIN = "aurora-mobile";

export const native = {
  call<T = void>(cmd: string, args?: Record<string, unknown>) {
    return invoke<T>(`plugin:${PLUGIN}|${cmd}`, args);
  },
  on<T>(event: string, cb: (payload: T) => void): Promise<PluginListener> {
    return addPluginListener<T>(PLUGIN, event, cb);
  },
};

/** State the playback service reports. */
export interface NativeState {
  /** Track ids in play order; only sent when the queue changed (e.g. Android Auto started a list). */
  ids?: string[];
  index: number;
  playing: boolean;
  loading: boolean;
  positionMs: number;
  durationMs: number;
  repeat?: "off" | "all" | "one";
  error?: string;
}

/** Listening that happened while the app's screen wasn't running (e.g. in the car). */
export interface NativePlay {
  id: string;
  startedAt: number; // unix seconds
  listenedMs: number;
  durationMs?: number;
}

export interface NativeOutput {
  id: string;
  label: string;
  kind: "speaker" | "wired" | "bluetooth" | "usb" | "hdmi" | "car" | "other";
}

/** Where downloads go by default: Music\Aurora on Windows, Download/Aurora on a phone. */
export async function defaultMusicFolder(): Promise<string> {
  const { isAndroid } = await import("./platform");
  if (isAndroid) {
    try {
      return (await native.call<{ path: string }>("musicFolder")).path;
    } catch {
      /* older app build: fall through */
    }
  }
  const { join } = await import("@tauri-apps/api/path");
  return join(await musicDir(), "Aurora");
}

/** "/storage/emulated/0/Download/Aurora" → "Download/Aurora" (how the Files app shows it). */
export const prettyPath = (p: string) =>
  p.replace(/^\/storage\/emulated\/\d+\//, "").replace(/^\/sdcard\//, "").replace(/^\/home\/[^/]+(?=\/|$)/, "~");

/** The phone version's first default (inside Android/data, hard to find). */
export const isOldPhoneDefault = (p: string) => /\/Android\/data\/[^/]+\/files\/Music\/Aurora\/?$/.test(p);

/**
 * The user's Music folder. Linux only knows it when the XDG user folders are
 * set up (xdg-user-dirs); many minimal setups (Hyprland, Sway…) don't have
 * that, so fall back to ~/Music instead of failing.
 */
export async function musicDir(): Promise<string> {
  const p = await import("@tauri-apps/api/path");
  try {
    return await p.audioDir();
  } catch {
    return p.join(await p.homeDir(), "Music");
  }
}

/** The Documents folder, or the home folder when the system doesn't name one. */
export async function documentsDir(): Promise<string> {
  const p = await import("@tauri-apps/api/path");
  try {
    return await p.documentDir();
  } catch {
    return p.homeDir();
  }
}
