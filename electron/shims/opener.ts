import { bridge } from "./bridge";

export const openUrl = (url: string | URL) => bridge.call("open:url", String(url)) as Promise<void>;
export const openPath = (path: string) => bridge.call("open:path", path) as Promise<void>;
export const revealItemInDir = (path: string) => bridge.call("open:reveal", path) as Promise<void>;
