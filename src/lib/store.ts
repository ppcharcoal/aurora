import { invoke } from "@tauri-apps/api/core";

/** Persistent JSON values stored by the Rust side in the app data folder. */
export async function storeGet<T>(key: string): Promise<T | null> {
  try {
    return (await invoke<T | null>("store_get", { key })) ?? null;
  } catch (e) {
    console.warn("store_get failed", key, e);
    return null;
  }
}

let paused = false;

export async function storeSet(key: string, value: unknown): Promise<void> {
  if (paused) return;
  await invoke("store_set", { key, value });
}

/** Used while a backup is being restored, so nothing overwrites the restored files. */
export function pauseSaves() {
  paused = true;
}

const pending = new Map<string, () => Promise<void>>();

/** Debounced writer so rapid changes (e.g. volume drag) cause one disk write. */
export function debouncedSaver(key: string, delay = 400) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (value: unknown) => {
    clearTimeout(t);
    const run = () => {
      pending.delete(key);
      return storeSet(key, value).catch(console.warn);
    };
    pending.set(key, run);
    t = setTimeout(run, delay);
  };
}

/** Writes every pending debounced save now (before a backup or profile switch). */
export async function flushSaves() {
  await Promise.all([...pending.values()].map((run) => run()));
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    for (const run of pending.values()) run();
  });
}
