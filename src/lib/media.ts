import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { isLinux } from "./platform";

/**
 * Where the <audio> element gets a local file from.
 * Windows: Tauri's asset protocol. Linux: WebKitGTK's GStreamer can't read
 * that, so the Rust side serves songs on a private 127.0.0.1 address instead
 * (see src-tauri/src/media_server.rs).
 */
let base: string | null = null;

export async function initMedia() {
  if (!isLinux) return;
  base = await invoke<string | null>("media_base").catch(() => null);
}

export function mediaSrc(path: string): string {
  return base ? base + encodeURIComponent(path) : convertFileSrc(path);
}
