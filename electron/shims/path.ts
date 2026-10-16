import { bridge } from "./bridge";

export async function join(...parts: string[]): Promise<string> {
  return parts
    .filter((p) => p !== "")
    .join("/")
    .replace(/\/{2,}/g, "/");
}
export const homeDir = async () => bridge.paths.home;
export const audioDir = async () => bridge.paths.music;
export const documentDir = async () => bridge.paths.documents;
export const sep = () => "/";
