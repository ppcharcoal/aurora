/**
 * The Electron app's preload (electron/preload.cjs) exposes `window.aurora`.
 * These shims stand in for the @tauri-apps packages in the Electron build
 * (see vite.config.ts), so the Svelte app runs unchanged.
 */
export interface Bridge {
  invoke(cmd: string, args?: unknown): Promise<{ ok: boolean; data?: unknown; error?: unknown }>;
  on(event: string, cb: (payload: unknown) => void): () => void;
  mediaBase: string;
  paths: { home: string; music: string; documents: string };
  call(channel: string, ...args: unknown[]): Promise<unknown>;
}

export const bridge = (globalThis as unknown as { aurora: Bridge }).aurora;
