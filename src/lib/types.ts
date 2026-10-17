export type RGB = [number, number, number];

/** A song in the local library. */
export interface Track {
  /** Stable id derived from the file path. */
  key: string;
  id: string;
  path: string;
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  /** File size in bytes. */
  size?: number;
  art?: string;
  /** The cover picture file itself (local songs), for the Discord bot. */
  coverPath?: string;
  color?: RGB;
}

/** A local album, grouped from tags. */
export interface Album {
  id: string;
  name: string;
  subtitle: string;
  art?: string;
  tracks: Track[];
}

export interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
  /** Custom cover, copied into Aurora's data folder. */
  cover?: string;
  created: number;
  updated: number;
}

/** One YouTube search result (from yt-dlp). */
export interface SearchResult {
  /** YouTube video id, or the page URL on other sites. */
  id: string;
  title: string;
  channel?: string | null;
  durationMs: number;
  views?: number | null;
  live: boolean;
  site: "youtube" | "soundcloud";
  thumb?: string | null;
  /** SoundCloud Go+ track: only a 30-second clip is available. */
  previewOnly?: boolean;
}

/** An album found on YouTube Music (from yt-dlp). */
export interface AlbumResult {
  id: string;
  url: string;
  title: string;
  artist: string;
  thumb?: string | null;
  year?: number | null;
  tracks: { id: string; title: string; durationMs: number; artist?: string; preview?: string }[];
}

/** A song from the music catalog ("Music only" search). */
export interface CatalogTrack {
  /** "dz:<id>" (Deezer) or "it:<id>" (iTunes) */
  id: string;
  title: string;
  artist: string;
  album?: string | null;
  cover?: string | null;
  durationMs: number;
  explicit: boolean;
  year?: number | null;
  /** 30-second clip from the catalog. */
  preview?: string | null;
}

export type DownloadStatus = "queued" | "downloading" | "converting" | "done" | "error" | "canceled";

export interface DownloadItem {
  /** Video id, or "album:<id>" for a whole album. */
  id: string;
  kind: "song" | "album";
  title: string;
  artist: string;
  thumb: string;
  durationMs: number;
  status: DownloadStatus;
  percent: number;
  speed: string;
  eta: string;
  error?: string;
  path?: string;
  /** Add to this playlist once finished. */
  playlistId?: string;
  /** Catalog song: the YouTube source is looked up when the download starts. */
  catalog?: CatalogTrack;
  /** Radio: add to the play queue as soon as it's downloaded. */
  thenQueue?: boolean;
  /** "Retrying (2 of 3)…" while yt-dlp tries again. */
  retry?: string;
  /* Albums only */
  album?: AlbumResult;
  completed?: number;
  failed?: number;
  current?: string;
  currentVideo?: string;
  paths?: string[];
}

export type Route =
  | { name: "home" }
  | { name: "library" }
  | { name: "search"; q?: string }
  | { name: "settings" }
  | { name: "album"; album: Album }
  | { name: "playlist"; id: string }
  | { name: "profile" }
  | { name: "loved" }
  | { name: "friends" }
  | { name: "downloads"; tab?: "queue" | "lastfm" }
  | { name: "discord" };
