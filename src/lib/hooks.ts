import type { Track } from "./types";

/**
 * The player calls these; Last.fm registers them at startup. Kept separate so
 * player.svelte.ts doesn't import lastfm.svelte.ts (which imports the player).
 */
export const scrobbleHooks: {
  start?: (t: Track) => void;
  listen?: (t: Track, ms: number) => void;
  /** A finished play logged by the Android playback service. */
  logged?: (t: Track, listenedMs: number, startedAt: number, durationMs: number) => void;
  /** Main player started playing (stops any preview). */
  playing?: () => void;
} = {};

/** The Discord bot follows the player; it registers these (src/lib/discord.svelte.ts). */
export const discordHooks: {
  /** The user moved to another point in the song. */
  seek?: (ms: number) => void;
} = {};
