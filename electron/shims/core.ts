import { bridge } from "./bridge";

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const r = await bridge.invoke(cmd, args ?? {});
  if (!r.ok) throw r.error;
  return r.data as T;
}

/** Local files are shown through Aurora's private 127.0.0.1 server (see src-tauri/src/media_server.rs). */
export function convertFileSrc(path: string): string {
  return bridge.mediaBase + encodeURIComponent(path);
}

export type PluginListener = { unregister(): Promise<void> };

/** Android-only in the Tauri app; never called on Linux. */
export async function addPluginListener<T>(_plugin: string, _event: string, _cb: (p: T) => void): Promise<PluginListener> {
  return { unregister: async () => {} };
}
