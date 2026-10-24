import { invoke } from "@tauri-apps/api/core";
import { untrack } from "svelte";
import { listen } from "@tauri-apps/api/event";
import { discordHooks } from "./hooks";
import { isAndroid } from "./platform";
import { player } from "./player.svelte";
import { settings } from "./settings.svelte";
import { loudness } from "./loudness.svelte";
import { debouncedSaver, storeGet } from "./store";
import type { Track } from "./types";

/**
 * Discord, on Windows and Linux:
 *  - the bot: plays what Aurora plays in a voice channel. Aurora's player stays
 *    in charge; the bot (src-tauri/src/discord.rs + discord/src/main.js)
 *    follows it. While it's in a voice channel it is the audio output: this
 *    computer stays quiet and Aurora's volume slider sets the call's volume.
 *  - Rich Presence: "Listening to …" on your own profile (src-tauri/src/presence.rs).
 */

export interface DiscordConfig {
  /** Post a now-playing card in the voice channel's chat. */
  nowPlaying: boolean;
  /** Connect the bot when Aurora starts. */
  autoStart: boolean;
  /** The last voice channel, to offer it again. */
  last: { guildId: string; channelId: string } | null;
  /** Rich Presence: show what you're listening to on your profile. */
  presence: boolean;
  /** Discord application id used for Rich Presence (empty = the bot's). */
  presenceAppId: string;
}

const defaults: DiscordConfig = {
  nowPlaying: true,
  autoStart: false,
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
  /** The song Discord is hearing. */
  path?: string | null;
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
  private sentNorms = "";
  private sentPlan = "";
  private sentNext = "";
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
          // Went into this song through a transition the bot was told about: it does that itself.
          const bySelf = untrack(() => player.mixedInto) === t.key && this.sentNext === t.key;
          this.sentKey = t.key;
          this.sentOn = on;
          if (!bySelf) this.playTrack(t, pos, !on);
        } else if (this.sentOn !== on) {
          this.sentOn = on;
          this.send({ t: on ? "resume" : "pause", positionMs: Math.round(pos) });
        }
      });
      // What comes next (and the transition into it): the bot mixes it the same way.
      $effect(() => {
        const plan = player.nextPlan;
        const cur = player.current;
        if (!this.live || !cur) return;
        const key = JSON.stringify([cur.key, plan?.track.key, plan?.mix]);
        if (key === this.sentPlan) return;
        this.sentPlan = key;
        this.sentNext = plan?.track.key ?? "";
        this.send({ t: "next", from: cur.path, next: this.nextMsg(cur) }, true);
      });
      // Volume sync switched or a song measured: the bot changes the level straight away.
      $effect(() => {
        void loudness.version;
        void settings.value.volumeSync;
        const cur = player.current;
        const nxt = player.nextPlan?.track;
        if (!this.live || !cur) return;
        const norms: Record<string, number> = {};
        for (const t of [cur, nxt]) if (t) norms[t.path] = untrack(() => loudness.gainOf(t));
        const key = JSON.stringify(norms);
        if (key === this.sentNorms) return;
        this.sentNorms = key;
        this.send({ t: "norm", norms }, true);
      });
      // The bot is the audio output while it's in a channel: this computer stays quiet.
      $effect(() => {
        player.setLocalMuted(this.live);
      });
      // …and Aurora's volume slider sets the volume in the call.
      $effect(() => {
        const v = settings.value.volume;
        if (untrack(() => this.live)) this.send({ t: "volume", volume: v }, true);
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
    if (k === "nowPlaying") this.send({ t: "settings", nowPlaying: this.cfg.nowPlaying }, true);
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
      await invoke("discord_start", { nowPlaying: this.cfg.nowPlaying });
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

  private trackMsg(t: Track) {
    const c = t.color;
    return {
      path: t.path,
      title: t.title,
      artist: t.artist,
      album: t.album ?? "",
      durationMs: t.durationMs,
      cover: t.coverPath ?? null,
      color: c ? (c[0] << 16) | (c[1] << 8) | c[2] : null,
      // Volume sync: the bot turns each song up or down the same way.
      norm: loudness.gainOf(t),
    };
  }

  /** The next song and how to go into it. "None" becomes a gapless join. */
  private nextMsg(cur: Track) {
    const plan = untrack(() => player.nextPlan);
    if (!plan) return null;
    const mix =
      plan.mix ?? { bStart: cur.durationMs, aEnd: cur.durationMs, bOffset: 0, fadeOut: 0, fadeIn: 0, aGain: 1, bGain: 1, curve: "linear" };
    return { ...this.trackMsg(plan.track), mix: $state.snapshot(mix) };
  }

  private playTrack(t: Track, offsetMs: number, paused: boolean) {
    const plan = untrack(() => player.nextPlan);
    this.sentNext = plan?.track.key ?? "";
    this.sentPlan = JSON.stringify([t.key, plan?.track.key, plan?.mix]);
    const c = t.color;
    this.send({
      next: this.nextMsg(t),
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
      norm: loudness.gainOf(t),
      volume: settings.value.volume,
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
        // (Only when both are on the same song: during a transition they can be a moment apart.)
        if (
          this.live &&
          player.playing &&
          this.voice.playing &&
          this.voice.path === player.current?.path &&
          !player.mixing &&
          Math.abs(this.voice.positionMs - player.position) > 2500
        ) {
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
