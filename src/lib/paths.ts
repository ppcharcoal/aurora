import { convertFileSrc, invoke } from "@tauri-apps/api/core";

interface AppPaths {
  data: string;
  playlistCovers: string;
  avatars: string;
  wallpapers: string;
  sep: string;
}

let paths: AppPaths | null = null;

export async function loadPaths() {
  paths = await invoke<AppPaths>("app_paths");
}

export type ImageKind = "playlist" | "avatar" | "wallpaper";

/** Images are stored as plain file names inside Aurora's data folder. */
export function imageSrc(kind: ImageKind, name?: string | null): string | undefined {
  if (!name || !paths) return undefined;
  const base = name.split(/[\\/]/).pop()!;
  const dir = kind === "playlist" ? paths.playlistCovers : kind === "avatar" ? paths.avatars : paths.wallpapers;
  return convertFileSrc(`${dir}${paths.sep}${base}`);
}

/** Older versions stored a full path; keep only the file name. */
export const fileName = (v?: string | null) => (v ? v.split(/[\\/]/).pop() : undefined);
