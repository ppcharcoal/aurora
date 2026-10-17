import { invoke } from "@tauri-apps/api/core";
import { untrack } from "svelte";
import { listen } from "@tauri-apps/api/event";
import { discordHooks } from "./hooks";
import { isAndroid } from "./platform";
import { player } from "./player.svelte";
import { settings } from "./settings.svelte";
import { library } from "./sources/local.svelte";
import { debouncedSaver, storeGet } from "./store";
import type { Album, Track } from "./types";
import { ui } from "./ui.svelte";

/**
 * Discord, on Windows and Linux:
 *  - the bot: plays what Aurora plays in a voice channel. Aurora's player stays
 *    in charge; the bot (src-tauri/src/discord.rs + discord/src/main.js)
 *    follows it, and commands typed in Discord are carried out here.
 *  - Rich Presence: "Listening to …" on your own profile (src-tauri/src/presence.rs).
 */

export type Control = "voice" | "everyone" | "owner" | "none";

export interface DiscordConfig {
  /** Who may use /play, /skip… and the buttons in Discord. */
  control: Control;
  /** Post a now-playing card with buttons in the voice channel's chat. */
  nowPlaying: boolean;
  /** Keep playing on this computer's speakers too (otherwise only in Discord). */
  hearHere: boolean;
  /** Connect the bot when Aurora starts. */
  autoStart: boolean;
  /** Volume in the call, 0–1.5 (1 = as the file is). */
  volume: number;
  /** The last voice channel, to offer it again. */
  last: { guildId: string; channelId: string } | null;
  /** Rich Presence: show what you're listening to on your profile. */
  presence: boolean;
  /** Discord application id used for Rich Presence (empty = the bot's). */
  presenceAppId: string;
}

const defaults: DiscordConfig = {
  control: "voice",
  nowPlaying: true,
  hearHere: true,
  autoStart: false,
  volume: 1,
  last: null,
  presence: false,
  presenceAppId: "",
};

export interface Guild {
  id: string;
  name: string;
  icon: string | null;
  channels: { id: string; name: string; listeners: number }[];
}

interface BotState {
  voice: "off" | "connecting" | "connected";
  guildId: string | null;
  channelId: string | null;
  playing: boolean;
  paused: boolean;
  positionMs: number;
}

const ICON_URL = "https://raw.githubusercontent.com/ppcharcoal/aurora/main/src-tauri/icons/128x128%402x.png";
export const PORTAL_URL = "https://discord.com/developers/applications";

/** Discord wants 2–128 characters in each line of a status. */
const line = (s: string | undefined, fallback: string) => {
  const t = (s ?? "").trim() || fallback;
  return (t.length < 2 ? t + " " : t).slice(0, 128);
};

class Discord {
  cfg = $state<DiscordConfig>({ ...defaults });
  /** Saved token: only a hint of it ever reaches the window. */
  token = $state<{ saved: boolean; hint?: string | null; appId?: string | null }>({ saved: false });
  status = $state<"off" | "starting" | "online" | "offline">("off");
  error = $state("");
  bot = $state<{ id: string; name: string; avatar: string } | null>(null);
  invite = $state("");
  guilds = $state.raw<Guild[]>([]);
  voice = $state<BotState>({ voice: "off", guildId: null, channelId: null, playing: false, paused: false, positionMs: 0 });
  presenceError = $state("");

  /** Music is going to a voice channel right now. */
  live = $derived(this.status === "online" && this.voice.voice === "connected");
  readonly supported = !isAndroid;

  private save: (v: unknown) => void = () => {};
  private started = false;
  private sentKey = "";
  private sentOn = false;
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPresence = "";
  private presenceShown = false;

  async init() {
    if (this.started || isAndroid) return;
    this.started = true;
    this.save = debouncedSaver("discord");
    this.cfg = { ...defaults, ...((await storeGet<Partial<DiscordConfig>>("discord")) ?? {}) };
    await this.refreshToken();
    // After a page reload the old bot may still be running: start clean.
    await invoke("discord_stop").catch(() => {});
    await listen<Record<string, unknown>>("discord://event", (e) => this.onEvent(e.payload));
    discordHooks.seek = (ms) => {
      if (this.live && player.current) this.send({ t: "seek", positionMs: Math.round(ms) });
      this.schedulePresence();
    };
    $effect.root(() => {
      // Follow the player: new song, pause / play.
      $effect(() => {
        const t = player.current;
        const live = this.live;
        const on = player.playing || player.loading;
        if (!live) {
          this.sentKey = "";
          return;
        }
        if (!t) return;
        // The position is read without following it (it changes 4× a second).
        const pos = untrack(() => (player.loading ? 0 : player.position));
        if (this.sentKey !== t.key) {
          this.sentKey = t.key;
          this.sentOn = on;
          this.playTrack(t, pos, !on);
        } else if (this.sentOn !== on) {
          this.sentOn = on;
          this.send({ t: on ? "resume" : "pause", positionMs: Math.round(pos) });
        }
      });
      // Speakers on this computer: muted while the music plays only in Discord.
      $effect(() => {
        player.setLocalMuted(this.live && !this.cfg.hearHere);
      });
      // Rich Presence follows the song and pause state.
      $effect(() => {
        void player.current;
        void player.playing;
        void this.cfg.presence;
        void this.presenceId;
        this.schedulePresence();
      });
    });
    if (this.cfg.autoStart && this.token.saved) this.start().catch(() => {});
  }

  set<K extends keyof DiscordConfig>(k: K, v: DiscordConfig[K]) {
    this.cfg[k] = v;
    this.save($state.snapshot(this.cfg));
    if (k === "control" || k === "nowPlaying") this.send({ t: "settings", control: this.cfg.control, nowPlaying: this.cfg.nowPlaying }, true);
    if (k === "volume") this.send({ t: "volume", volume: v }, true);
  }

  async refreshToken() {
    this.token = await invoke<{ saved: boolean; hint: string | null; appId: string | null }>("discord_token_info").catch(() => ({ saved: false }));
  }

  /** Saves a pasted token and connects. */
  async connect(token: string) {
    this.error = "";
    await invoke("discord_token_set", { token });
    await this.refreshToken();
    await this.start();
  }

  async start() {
    this.error = "";
    this.status = "starting";
    try {
      await invoke("discord_start", { control: this.cfg.control, nowPlaying: this.cfg.nowPlaying });
    } catch (e) {
      this.status = "off";
      this.error = String(e);
      throw e;
    }
  }

  async stop() {
    this.send({ t: "leave" }, true);
    await invoke("discord_stop").catch(() => {});
    this.status = "off";
    this.bot = null;
    this.voice = { ...this.voice, voice: "off" };
  }

  /** Forgets the token (the bot disconnects). */
  async forget() {
    await this.stop();
    await invoke("discord_token_set", { token: null });
    this.guilds = [];
    this.invite = "";
    await this.refreshToken();
  }

  join(guildId: string, channelId: string) {
    this.error = "";
    this.set("last", { guildId, channelId });
    this.voice = { ...this.voice, voice: "connecting", guildId, channelId };
    this.send({ t: "join", guildId, channelId });
  }

  leave() {
    this.send({ t: "leave" });
  }

  private send(msg: Record<string, unknown>, quiet = false) {
    if (this.status === "off") return;
    invoke("discord_send", { msg }).catch((e) => {
      if (!quiet) this.error = String(e);
    });
  }

  private playTrack(t: Track, offsetMs: number, paused: boolean) {
    const c = t.color;
    this.send({
      t: "play",
      path: t.path,
      offsetMs: Math.round(offsetMs),
      paused,
      title: t.title,
      artist: t.artist,
      album: t.album ?? "",
      durationMs: t.durationMs,
      cover: t.coverPath ?? null,
      color: c ? (c[0] << 16) | (c[1] << 8) | c[2] : null,
      volume: this.cfg.volume,
    });
  }

  private onEvent(m: Record<string, unknown>) {
    switch (m.t) {
      case "ready": {
        this.status = "online";
        this.error = "";
        this.bot = m.user as Discord["bot"];
        this.invite = String(m.invite ?? "");
        this.guilds = (m.guilds as Guild[]) ?? [];
        break;
      }
      case "guilds":
        this.guilds = (m.guilds as Guild[]) ?? [];
        break;
      case "state": {
        const prev = this.voice.voice;
        this.voice = m as unknown as BotState;
        if (this.voice.voice === "connected" && prev !== "connected") this.sentKey = "";
        // Drifted apart (a slow disk, a hiccup in the call): line the bot up with the player again.
        if (this.live && player.playing && this.voice.playing && Math.abs(this.voice.positionMs - player.position) > 2500) {
          this.send({ t: "seek", positionMs: Math.round(player.position) });
        }
        break;
      }
      case "offline":
        this.status = "offline";
        break;
      case "error":
        this.error = String(m.message ?? "Something went wrong");
        if (m.code === "token" || m.code === "network") this.status = "off";
        break;
      case "exit":
        if (this.status !== "off" && !this.error) this.error = "The Discord bot stopped. Connect it again.";
        this.status = "off";
        this.voice = { ...this.voice, voice: "off" };
        this.bot = null;
        break;
      case "log":
        console.info("[discord]", m.message);
        break;
      case "command":
        this.command(Number(m.id), String(m.cmd), (m.args ?? {}) as Record<string, string>, m.user as { name: string } | null);
        break;
    }
  }

  /* ------------------------------------------------- Discord commands -- */

  private reply(id: number, text: string, extra: Record<string, unknown> = {}) {
    this.send({ t: "reply", id, text, ...extra }, true);
  }

  private find(query: string): { track?: Track; album?: Album } {
    const q = query.trim();
    if (q.startsWith("t:")) return { track: library.byId.get(q.slice(2)) };
    if (q.startsWith("a:")) return { album: library.albums.find((a) => a.id === q.slice(2)) };
    const hits = this.search(q);
    return hits[0]?.value.startsWith("a:") ? { album: library.albums.find((a) => a.id === hits[0].value.slice(2)) } : { track: hits[0] ? library.byId.get(hits[0].value.slice(2)) : undefined };
  }

  /** Library search for /play: songs first, then albums. */
  search(query: string): { name: string; value: string }[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const has = (s: string) => words.every((w) => s.includes(w));
    const tracks = library.tracks;
    if (!words.length) {
      return player.recent.slice(0, 15).map((t) => ({ name: `${t.title} — ${t.artist}`, value: `t:${t.id}` }));
    }
    const songs: { name: string; value: string; score: number }[] = [];
    for (const t of tracks) {
      const title = t.title.toLowerCase();
      const all = `${title} ${t.artist.toLowerCase()} ${(t.album ?? "").toLowerCase()}`;
      if (!has(all)) continue;
      const score = (has(title) ? 2 : 0) + (title.startsWith(words[0]) ? 1 : 0);
      songs.push({ name: `${t.title} — ${t.artist}`, value: `t:${t.id}`, score });
      if (songs.length > 400) break;
    }
    songs.sort((a, b) => b.score - a.score);
    const albums = library.albums
      .filter((a) => has(`${a.name} ${a.subtitle}`.toLowerCase()))
      .slice(0, 5)
      .map((a) => ({ name: `💿 ${a.name} — ${a.subtitle} (album)`, value: `a:${a.id}` }));
    return [...songs.slice(0, 20).map(({ name, value }) => ({ name, value })), ...albums].slice(0, 25);
  }

  private command(id: number, cmd: string, args: Record<string, string>, user: { name: string } | null) {
    const who = user?.name ?? "Someone";
    const now = (t: Track | null) => (t ? `**${t.title}** — ${t.artist}` : "nothing");
    switch (cmd) {
      case "search":
        return this.reply(id, "", { items: this.search(args.query ?? "") });
      case "play":
      case "add": {
        const { track, album } = this.find(args.query ?? "");
        if (!track && !album) return this.reply(id, `Nothing in the library matches “${args.query}”.`);
        if (cmd === "play") {
          if (album) player.playList(album.tracks, 0);
          else if (track) {
            player.playNext(track);
            if (player.queue[player.index]?.key !== track.key) player.jumpTo(player.index + 1);
          }
          ui.toast(`${who} played ${album ? album.name : track!.title} from Discord`, "info", 3000);
          return this.reply(id, album ? `▶️ Playing the album **${album.name}** (${album.tracks.length} songs)` : `▶️ Playing ${now(track!)}`);
        }
        for (const t of album ? album.tracks : [track!]) player.addToQueue(t, true);
        ui.toast(`${who} added ${album ? album.name : track!.title} from Discord`, "info", 3000);
        return this.reply(id, album ? `➕ Added the album **${album.name}** to the queue` : `➕ Added ${now(track!)} to the queue`);
      }
      case "pause":
        if (player.playing) player.toggle();
        return this.reply(id, "⏸️ Paused");
      case "resume":
        if (!player.playing) player.toggle();
        return this.reply(id, "▶️ Playing");
      case "toggle":
        player.toggle();
        return this.reply(id, "");
      case "skip":
        player.next();
        return this.reply(id, `⏭️ Skipped. Up now: ${now(player.queue[player.index] ?? null)}`);
      case "previous":
        player.prev();
        return this.reply(id, "⏮️ Back");
      case "stop":
        // The bot leaves; music carries on here only if you were listening here too.
        if (!this.cfg.hearHere && player.playing) player.toggle();
        return this.reply(id, "⏹️ Stopped");
      case "np": {
        const t = player.current;
        if (!t) return this.reply(id, "Nothing is playing.");
        const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
        return this.reply(id, `${player.playing ? "▶️" : "⏸️"} ${now(t)}${t.album ? ` · ${t.album}` : ""}\n\`${fmt(player.position)} / ${fmt(player.duration)}\``);
      }
      case "queue": {
        const next = player.upNext.slice(0, 10);
        const rest = player.upNext.length - next.length;
        return this.reply(
          id,
          `Now: ${now(player.current)}\n` +
            (next.length ? next.map((t, i) => `${i + 1}. ${t.title} — ${t.artist}`).join("\n") + (rest > 0 ? `\n…and ${rest} more` : "") : "Nothing queued after this one."),
        );
      }
      default:
        return this.reply(id, "Aurora doesn't know that command yet.");
    }
  }

  /* --------------------------------------------------- Rich Presence -- */

  /** The application whose name Discord shows: the one typed in, or the bot's. */
  get presenceId() {
    return this.cfg.presenceAppId.trim() || this.token.appId || "";
  }

  private schedulePresence() {
    clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(() => this.pushPresence(), 800);
  }

  private async pushPresence() {
    const id = this.presenceId;
    if (!id) return;
    const t = player.current;
    let activity: Record<string, unknown> | null = null;
    if (this.cfg.presence && t && player.playing) {
      const start = Date.now() - Math.round(player.position);
      activity = {
        type: 2, // "Listening to"
        status_display_type: 2, // the member list shows the song, not the app's name
        details: line(t.title, "Unknown song"),
        state: line(t.artist, "Unknown artist"),
        timestamps: t.durationMs ? { start, end: start + t.durationMs } : { start },
        assets: {
          large_image: t.art && /^https:/.test(t.art) ? t.art : ICON_URL,
          large_text: line(t.album || t.title, "Aurora"),
        },
      };
    }
    if (!activity && !this.presenceShown) return;
    const key = JSON.stringify([id, activity && { ...activity, timestamps: null }, activity ? Math.round((activity.timestamps as { start: number }).start / 3000) : 0]);
    if (key === this.lastPresence) return;
    this.lastPresence = key;
    try {
      await invoke("presence_set", { clientId: id, activity });
      this.presenceShown = !!activity;
      this.presenceError = "";
    } catch (e) {
      // Not shown as an error while it's off; Discord simply may not be running.
      this.presenceError = this.cfg.presence ? String(e) : "";
      this.lastPresence = "";
    }
  }

  /** Called when the Rich Presence switch or id changes. */
  async refreshPresence() {
    this.lastPresence = "";
    await this.pushPresence();
  }
}

export const discord = new Discord();
