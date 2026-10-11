import { invoke } from "@tauri-apps/api/core";
import { cached } from "./cache";
import { downloads } from "./downloads.svelte";
import { albumKey, songKey } from "./match";
import { player } from "./player.svelte";
import { profiles } from "./profiles.svelte";
import { library } from "./sources/local.svelte";
import { stats } from "./stats.svelte";
import { scrobbleHooks } from "./hooks";
import { debouncedSaver, storeGet, storeSet } from "./store";
import type { AlbumResult, CatalogTrack, Track } from "./types";
import { ui } from "./ui.svelte";

/* ------------------------------- types ------------------------------- */

export interface LfmOptions {
  scrobble: boolean;
  nowPlaying: boolean;
  syncLoved: boolean;
  discover: boolean;
  artistInfo: boolean;
  /** Download songs you ♥ elsewhere (e.g. on your phone) automatically. */
  autoDownloadLoved: boolean;
}

interface LfmProfile extends LfmOptions {
  user?: string;
  sk?: string;
}

interface Scrobble {
  artist: string;
  track: string;
  album?: string;
  timestamp: number;
  duration?: number;
}

export interface LovedSong {
  artist: string;
  title: string;
  date: number;
}

export interface HistoryItem {
  artist: string;
  title: string;
  plays: number;
}

export interface History {
  importedAt: number;
  playcount: number;
  registered?: number;
  tracks: HistoryItem[];
  artists: { name: string; plays: number }[];
}

export interface ArtistInfo {
  name: string;
  bio: string;
  tags: string[];
  listeners?: number;
  userPlays?: number;
  url?: string;
  picture?: string | null;
  similar: string[];
}

export interface FriendTrack {
  artist: string;
  title: string;
  album?: string;
  image?: string;
  nowPlaying: boolean;
  /** ms since epoch; absent while now playing */
  when?: number;
  catalog?: CatalogTrack | null;
}

export interface Friend {
  name: string;
  realname?: string;
  image?: string;
  url?: string;
  tracks: FriendTrack[];
}

/** One row in Downloads → From Last.fm. */
export interface SyncItem {
  key: string;
  kind: "song" | "album";
  artist: string;
  title: string;
  /** Why it's listed: "Recently played", "Loved", "Top song", "Top album". */
  reason: string;
  plays?: number;
  have: boolean;
  /** Filled in by the catalog lookup. */
  catalog?: CatalogTrack | null;
  album?: AlbumResult | null;
  looked?: boolean;
}

const defaults: LfmProfile = {
  scrobble: true,
  nowPlaying: true,
  syncLoved: true,
  discover: true,
  artistInfo: true,
  autoDownloadLoved: false,
};

const SCROBBLE_MIN_TRACK = 30_000;
const SCROBBLE_MAX_WAIT = 240_000;

const arr = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const num = (v: unknown) => Number(v ?? 0) || 0;
const stripHtml = (s: string) =>
  s
    .replace(/<a [^>]*>Read more on Last\.fm<\/a>\.?/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();

/* ------------------------------- store ------------------------------- */

class LastFm {
  /** API key + secret: app-wide (one Last.fm API account serves every profile). */
  apiKey = $state("");
  secret = $state("");
  cfg = $state<LfmProfile>({ ...defaults });
  loved = $state<Record<string, LovedSong>>({});
  history = $state.raw<History | null>(null);
  queueSize = $state(0);
  busy = $state<string | null>(null);

  /** This copy of Aurora has a Last.fm key built in: users only sign in. */
  builtin = $state(false);
  hasKey = $derived(this.builtin || (!!this.apiKey && !!this.secret));
  connected = $derived(!!this.cfg.sk);

  private queue: Scrobble[] = [];
  private lastRemoteLoved: string[] = [];
  private saveCfg: (v: unknown) => void = () => {};
  private saveLoved: (v: unknown) => void = () => {};
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Current play: start time and listened ms, for the scrobble rule. */
  private play = { key: "", started: 0, listened: 0, sent: false };

  /** Library index by normalised artist|title, for "do I have this?". */
  private index = $derived.by(() => {
    const m = new Map<string, Track>();
    for (const t of library.tracks) m.set(songKey(t.artist, t.title), t);
    return m;
  });
  private albumIndex = $derived.by(() => {
    const s = new Set<string>();
    for (const a of library.albums) s.add(albumKey(a.subtitle.split(",")[0] ?? "", a.name));
    return s;
  });

  find(artist: string, title: string): Track | undefined {
    return this.index.get(songKey(artist, title));
  }

  /* ---------------- setup ---------------- */

  async load() {
    this.builtin = await invoke<boolean>("lastfm_builtin").catch(() => false);
    const app = await storeGet<{ apiKey: string; secret: string }>("lastfm-app");
    this.apiKey = app?.apiKey ?? "";
    this.secret = app?.secret ?? "";
    this.saveCfg = debouncedSaver(profiles.key("lastfm"), 200);
    this.saveLoved = debouncedSaver(profiles.key("loved"), 500);
    this.cfg = { ...defaults, ...((await storeGet<LfmProfile>(profiles.key("lastfm"))) ?? {}) };
    const lovedFile = await storeGet<{ songs: Record<string, LovedSong>; remote: string[] }>(profiles.key("loved"));
    this.loved = lovedFile?.songs ?? {};
    this.lastRemoteLoved = lovedFile?.remote ?? [];
    this.queue = (await storeGet<Scrobble[]>(profiles.key("scrobbles"))) ?? [];
    this.queueSize = this.queue.length;
    this.history = await storeGet<History>(profiles.key("lastfm-history"));

    if (this.connected) {
      // Cached scrobbles first, then pick up loves made on other devices.
      this.flush();
      if (this.cfg.syncLoved) setTimeout(() => this.syncLoved().catch(() => {}), 3000);
    }
  }

  async saveKeys(apiKey: string, secret: string) {
    this.apiKey = apiKey.trim();
    this.secret = secret.trim();
    await storeSet("lastfm-app", { apiKey: this.apiKey, secret: this.secret });
  }

  setOption<K extends keyof LfmOptions>(k: K, v: LfmOptions[K]) {
    this.cfg[k] = v;
    this.saveCfg($state.snapshot(this.cfg));
  }

  async connect() {
    this.busy = "connect";
    try {
      const s = await invoke<{ name: string; key: string }>("lastfm_login");
      this.cfg.user = s.name;
      this.cfg.sk = s.key;
      this.saveCfg($state.snapshot(this.cfg));
      ui.toast(`Connected to Last.fm as ${s.name}`, "success");
      this.useLastfmProfile().catch(() => {});
      this.flush();
      if (this.cfg.syncLoved) this.syncLoved().catch(ui.error);
    } catch (e) {
      ui.error(e);
    } finally {
      this.busy = null;
    }
  }

  /** Sets this Aurora profile's name and picture from the Last.fm account. */
  async useLastfmProfile() {
    if (!this.cfg.user) return;
    const r = await this.call("user.getInfo", { user: this.cfg.user });
    const u = r?.user ?? {};
    const images = arr(u.image) as { size: string; "#text": string }[];
    const url = (images.find((i) => i.size === "extralarge") ?? images[images.length - 1])?.["#text"];
    // Last.fm's grey star placeholder isn't a real picture.
    const real = url && !url.includes("2a96cbd8b46e442fc41c2b86b821562f") ? url : undefined;
    await profiles.applyLastfm(profiles.activeId, u.realname || u.name || this.cfg.user, real);
  }

  disconnect() {
    this.cfg.user = undefined;
    this.cfg.sk = undefined;
    this.saveCfg($state.snapshot(this.cfg));
  }

  /** All Last.fm calls go through Rust (it signs them). */
  async call<T = any>(method: string, params: Record<string, string | number | undefined>, opts: { signed?: boolean; write?: boolean } = {}): Promise<T> {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") clean[k] = String(v);
    try {
      return await invoke<T>("lastfm_call", {
        method,
        params: clean,
        sk: opts.signed || opts.write ? (this.cfg.sk ?? null) : null,
        write: !!opts.write,
      });
    } catch (e) {
      const msg = String(e);
      if (msg.startsWith("LASTFM_SESSION")) this.disconnect();
      throw new Error(msg.replace(/^LASTFM_\w+: /, ""));
    }
  }

  /* ---------------- scrobbling ---------------- */

  /** Player: a track started. */
  onStart(t: Track) {
    this.play = { key: t.key, started: Math.floor(Date.now() / 1000), listened: 0, sent: false };
    if (this.connected && this.cfg.nowPlaying) {
      this.call(
        "track.updateNowPlaying",
        { artist: t.artist, track: t.title, album: t.album, duration: Math.round(t.durationMs / 1000) || undefined },
        { write: true },
      ).catch(() => {}); // Now Playing is never retried.
    }
  }

  /** Player: `ms` of real listening just happened. */
  onListen(t: Track, ms: number) {
    if (!this.cfg.scrobble || this.play.key !== t.key || this.play.sent) return;
    this.play.listened += ms;
    const dur = t.durationMs;
    // Last.fm rule: longer than 30 s, played for half its length or 4 minutes.
    if (dur > SCROBBLE_MIN_TRACK && this.play.listened >= Math.min(dur / 2, SCROBBLE_MAX_WAIT)) {
      this.play.sent = true;
      this.queue.push({
        artist: t.artist,
        track: t.title,
        album: t.album,
        timestamp: this.play.started,
        duration: Math.round(dur / 1000),
      });
      this.persistQueue();
      if (this.connected) this.flush();
    }
  }

  /** A whole play from the Android playback service's log (phone locked, car…). */
  onLogged(t: Track, listenedMs: number, startedAt: number, durationMs: number) {
    const dur = durationMs || t.durationMs;
    if (!this.cfg.scrobble || dur <= SCROBBLE_MIN_TRACK || listenedMs < Math.min(dur / 2, SCROBBLE_MAX_WAIT)) return;
    this.queue.push({ artist: t.artist, track: t.title, album: t.album, timestamp: startedAt, duration: Math.round(dur / 1000) });
    this.persistQueue();
    if (this.connected) this.flush();
  }

  private persistQueue() {
    this.queueSize = this.queue.length;
    storeSet(profiles.key("scrobbles"), this.queue).catch(() => {});
  }

  /** Sends cached scrobbles, oldest first, 50 at a time. Survives restarts. */
  async flush() {
    if (!this.connected || !this.queue.length || this.busy === "flush") return;
    this.busy = "flush";
    clearTimeout(this.retryTimer);
    try {
      while (this.queue.length) {
        const batch = this.queue.slice(0, 50);
        const p: Record<string, string | number | undefined> = {};
        batch.forEach((s, i) => {
          p[`artist[${i}]`] = s.artist;
          p[`track[${i}]`] = s.track;
          p[`timestamp[${i}]`] = s.timestamp;
          p[`album[${i}]`] = s.album;
          p[`duration[${i}]`] = s.duration;
        });
        try {
          await this.call("track.scrobble", p, { write: true });
          this.queue.splice(0, batch.length);
        } catch (e) {
          const msg = String(e);
          if (/temporarily|reach|Too many/i.test(msg)) {
            // Offline or Last.fm hiccup: keep them and try again later.
            this.retryTimer = setTimeout(() => this.flush(), 120_000);
            break;
          }
          // Anything else means the request itself was bad: drop that batch.
          console.warn("Dropping scrobble batch", msg, batch);
          this.queue.splice(0, batch.length);
        }
      }
    } finally {
      this.persistQueue();
      this.busy = null;
    }
  }

  /* ---------------- loved tracks ---------------- */

  isLoved(t: { artist: string; title: string }) {
    return !!this.loved[songKey(t.artist, t.title)];
  }

  async toggleLove(t: { artist: string; title: string }) {
    const k = songKey(t.artist, t.title);
    const nowLoved = !this.loved[k];
    if (nowLoved) this.loved[k] = { artist: t.artist, title: t.title, date: Date.now() };
    else delete this.loved[k];
    this.persistLoved();
    if (this.connected && this.cfg.syncLoved) {
      try {
        await this.call(nowLoved ? "track.love" : "track.unlove", { artist: t.artist, track: t.title }, { write: true });
        if (nowLoved) this.lastRemoteLoved = [...new Set([...this.lastRemoteLoved, k])];
        else this.lastRemoteLoved = this.lastRemoteLoved.filter((x) => x !== k);
        this.persistLoved();
      } catch (e) {
        ui.error(e);
      }
    }
  }

  private persistLoved() {
    this.saveLoved({ songs: $state.snapshot(this.loved), remote: this.lastRemoteLoved });
  }

  /**
   * Two-way sync. Loved on Last.fm (or another device) → loved here.
   * Unloved on Last.fm since the last sync → unloved here. Loved only here → sent to Last.fm.
   */
  async syncLoved() {
    if (!this.connected || !this.cfg.user) return;
    const remote: Record<string, LovedSong> = {};
    for (let page = 1; page <= 5; page++) {
      const r = await this.call("user.getLovedTracks", { user: this.cfg.user, limit: 1000, page });
      const items = arr(r?.lovedtracks?.track);
      for (const it of items) {
        const artist = it.artist?.name ?? it.artist?.["#text"] ?? "";
        const title = it.name ?? "";
        if (artist && title) remote[songKey(artist, title)] = { artist, title, date: num(it.date?.uts) * 1000 };
      }
      if (page >= num(r?.lovedtracks?.["@attr"]?.totalPages)) break;
    }
    const before = new Set(this.lastRemoteLoved);
    const newRemote: LovedSong[] = [];
    for (const [k, s] of Object.entries(remote)) {
      if (!this.loved[k]) {
        this.loved[k] = s;
        newRemote.push(s);
      }
    }
    for (const k of before) if (!remote[k] && this.loved[k]) delete this.loved[k];
    for (const [k, s] of Object.entries(this.loved)) {
      if (!remote[k] && !before.has(k)) {
        await this.call("track.love", { artist: s.artist, track: s.title }, { write: true }).catch(() => {});
        remote[k] = s;
      }
    }
    this.lastRemoteLoved = Object.keys(remote);
    this.persistLoved();

    if (this.cfg.autoDownloadLoved && newRemote.length) {
      const missing = newRemote.filter((s) => !this.find(s.artist, s.title)).slice(0, 25);
      if (missing.length) {
        const found = await invoke<(CatalogTrack | null)[]>("catalog_match_tracks", {
          items: missing.map((m) => ({ artist: m.artist, title: m.title })),
        });
        for (const c of found) if (c) downloads.enqueueCatalog(c, undefined, { quiet: true });
        ui.toast(`Downloading ${found.filter(Boolean).length} songs you loved elsewhere`, "info");
      }
    }
  }

  lovedLocal = $derived(
    Object.values(this.loved)
      .sort((a, b) => b.date - a.date)
      .map((s) => this.find(s.artist, s.title))
      .filter((t): t is Track => !!t),
  );

  /* ---------------- artist & album info ---------------- */

  artistInfo(name: string): Promise<ArtistInfo> {
    return cached(`lfm:artist:${name.toLowerCase()}`, async () => {
      const [r, picture] = await Promise.all([
        this.call("artist.getInfo", { artist: name, autocorrect: 1, username: this.cfg.user }),
        invoke<string | null>("catalog_artist_picture", { name }).catch(() => null),
      ]);
      const a = r?.artist ?? {};
      return {
        name: a.name ?? name,
        bio: stripHtml(a.bio?.summary ?? ""),
        tags: arr(a.tags?.tag).map((t: any) => t.name).slice(0, 6),
        listeners: num(a.stats?.listeners) || undefined,
        userPlays: a.stats?.userplaycount != null ? num(a.stats.userplaycount) : undefined,
        url: a.url,
        picture,
        similar: arr(a.similar?.artist).map((s: any) => s.name).slice(0, 6),
      };
    });
  }

  albumTags(artist: string, album: string): Promise<{ tags: string[]; wiki: string }> {
    return cached(`lfm:album:${artist}|${album}`.toLowerCase(), async () => {
      const r = await this.call("album.getInfo", { artist, album, autocorrect: 1 });
      return {
        tags: arr(r?.album?.tags?.tag).map((t: any) => t.name).slice(0, 6),
        wiki: stripHtml(r?.album?.wiki?.summary ?? ""),
      };
    });
  }

  /* ---------------- discovery & radio ---------------- */

  /** Songs by artists similar to what you listen to, that you don't have yet. */
  discover(): Promise<CatalogTrack[]> {
    return cached(`lfm:discover:${profiles.activeId}`, async () => {
      let seeds: string[] = [];
      if (this.connected && this.cfg.user) {
        const r = await this.call("user.getTopArtists", { user: this.cfg.user, period: "1month", limit: 6 });
        seeds = arr(r?.topartists?.artist).map((a: any) => a.name);
      }
      if (!seeds.length) {
        seeds = Object.entries(stats.value.artists)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([n]) => n);
      }
      if (!seeds.length) return [];
      const mine = new Set(library.tracks.map((t) => t.artist.toLowerCase()));
      const similar: string[] = [];
      for (const s of seeds.slice(0, 4)) {
        const r = await this.call("artist.getSimilar", { artist: s, limit: 8, autocorrect: 1 }).catch(() => null);
        for (const a of arr(r?.similarartists?.artist)) {
          const n = (a as any).name as string;
          if (n && !mine.has(n.toLowerCase()) && !similar.includes(n)) similar.push(n);
        }
      }
      const picks: { artist: string; title: string }[] = [];
      for (const a of similar.slice(0, 8)) {
        const r = await this.call("artist.getTopTracks", { artist: a, limit: 2, autocorrect: 1 }).catch(() => null);
        for (const t of arr(r?.toptracks?.track).slice(0, 2)) picks.push({ artist: a, title: (t as any).name });
      }
      const found = await invoke<(CatalogTrack | null)[]>("catalog_match_tracks", { items: picks });
      const seen = new Set<string>();
      return found.filter((c): c is CatalogTrack => !!c && !seen.has(c.id) && !!seen.add(c.id));
    });
  }

  /** Plays songs similar to `seed`: ones you have right away, missing ones as they download. */
  async startRadio(seed: Track) {
    this.busy = "radio";
    try {
      const r = await this.call("track.getSimilar", { artist: seed.artist, track: seed.title, limit: 40, autocorrect: 1 });
      const similar = arr(r?.similartracks?.track).map((t: any) => ({ artist: t.artist?.name ?? "", title: t.name ?? "" }));
      if (!similar.length) {
        ui.toast(`Last.fm doesn't know songs similar to “${seed.title}” yet.`);
        return;
      }
      const have: Track[] = [];
      const missing: { artist: string; title: string }[] = [];
      for (const s of similar) {
        const t = this.find(s.artist, s.title);
        if (t) have.push(t);
        else missing.push(s);
      }
      player.playList([seed, ...have.filter((t) => t.key !== seed.key)], 0);
      const toGet = missing.slice(0, 8);
      if (toGet.length) {
        const found = await invoke<(CatalogTrack | null)[]>("catalog_match_tracks", { items: toGet });
        const list = found.filter((c): c is CatalogTrack => !!c);
        for (const c of list) downloads.enqueueCatalog(c, undefined, { thenQueue: true, quiet: true });
        ui.toast(`Radio: ${have.length} songs from your library, downloading ${list.length} more`, "success");
      } else {
        ui.toast(`Radio: ${have.length} similar songs from your library`, "success");
      }
    } catch (e) {
      ui.error(e);
    } finally {
      this.busy = null;
    }
  }

  /* ---------------- friends ---------------- */

  /** People you follow on Last.fm and their last 3 songs, now-playing first. */
  async friends(): Promise<Friend[]> {
    if (!this.cfg.user) return [];
    const r = await this.call("user.getFriends", { user: this.cfg.user, limit: 50 });
    const list = arr(r?.friends?.user) as any[];
    const img = (v: any) => {
      const u = (arr(v) as any[]).find((i) => i.size === "large" || i.size === "extralarge")?.["#text"] || undefined;
      return u && !u.includes("2a96cbd8b46e442fc41c2b86b821562f") ? u : undefined;
    };
    const out: Friend[] = list.map((f) => ({ name: f.name, realname: f.realname || undefined, image: img(f.image), url: f.url, tracks: [] }));
    // A few at a time to stay polite with Last.fm's rate limit.
    for (let i = 0; i < out.length; i += 6) {
      await Promise.all(
        out.slice(i, i + 6).map(async (f) => {
          const rt = await this.call("user.getRecentTracks", { user: f.name, limit: 3 }).catch(() => null);
          f.tracks = (arr(rt?.recenttracks?.track) as any[]).slice(0, 3).map((t) => ({
            artist: t.artist?.["#text"] ?? t.artist?.name ?? "",
            title: t.name ?? "",
            album: t.album?.["#text"] || undefined,
            image: img(t.image),
            nowPlaying: t["@attr"]?.nowplaying === "true",
            when: t.date?.uts ? num(t.date.uts) * 1000 : undefined,
          }));
        }),
      );
    }
    // Catalog matches give covers, previews and something to download.
    const all = out.flatMap((f) => f.tracks).filter((t) => !this.find(t.artist, t.title));
    for (let i = 0; i < all.length; i += 30) {
      const batch = all.slice(i, i + 30);
      const found = await invoke<(CatalogTrack | null)[]>("catalog_match_tracks", {
        items: batch.map((t) => ({ artist: t.artist, title: t.title })),
      }).catch(() => batch.map(() => null));
      batch.forEach((t, j) => (t.catalog = found[j]));
    }
    const last = (f: Friend) => (f.tracks[0]?.nowPlaying ? Infinity : (f.tracks[0]?.when ?? 0));
    return out.filter((f) => f.tracks.length).sort((a, b) => last(b) - last(a));
  }

  /* ---------------- history import ---------------- */

  /** Imports your all-time Last.fm play counts (top 3000 songs, top 1000 artists). */
  async importHistory() {
    if (!this.cfg.user) return;
    this.busy = "import";
    try {
      const info = await this.call("user.getInfo", { user: this.cfg.user });
      const tracks: HistoryItem[] = [];
      for (let page = 1; page <= 3; page++) {
        const r = await this.call("user.getTopTracks", { user: this.cfg.user, period: "overall", limit: 1000, page });
        for (const t of arr(r?.toptracks?.track) as any[]) {
          tracks.push({ artist: t.artist?.name ?? "", title: t.name ?? "", plays: num(t.playcount) });
        }
        if (page >= num(r?.toptracks?.["@attr"]?.totalPages)) break;
      }
      const ar = await this.call("user.getTopArtists", { user: this.cfg.user, period: "overall", limit: 1000 });
      const h: History = {
        importedAt: Date.now(),
        playcount: num(info?.user?.playcount),
        registered: num(info?.user?.registered?.unixtime) * 1000 || undefined,
        tracks,
        artists: arr(ar?.topartists?.artist).map((a: any) => ({ name: a.name, plays: num(a.playcount) })),
      };
      this.history = h;
      await storeSet(profiles.key("lastfm-history"), h);
      // Give your songs their Last.fm play counts (keeps whichever is higher).
      const v = stats.value;
      let matched = 0;
      for (const it of tracks) {
        const t = this.find(it.artist, it.title);
        if (t && (v.plays[t.id] ?? 0) < it.plays) {
          v.plays[t.id] = it.plays;
          matched++;
        }
      }
      stats.value = { ...v };
      ui.toast(`Imported ${h.playcount.toLocaleString()} scrobbles; ${matched} of your songs got their play counts.`, "success", 6000);
    } catch (e) {
      ui.error(e);
    } finally {
      this.busy = null;
    }
  }

  /* ---------------- sync: what you play elsewhere vs. what's here ---------------- */

  async syncList(o: { recent: boolean; loved: boolean; top: boolean; albums: boolean; period: string }): Promise<SyncItem[]> {
    if (!this.cfg.user) return [];
    const user = this.cfg.user;
    const out = new Map<string, SyncItem>();
    const addSong = (artist: string, title: string, reason: string, plays?: number) => {
      if (!artist || !title) return;
      const key = "s:" + songKey(artist, title);
      if (out.has(key)) return;
      out.set(key, { key, kind: "song", artist, title, reason, plays, have: !!this.find(artist, title) });
    };
    if (o.recent) {
      for (let page = 1; page <= 2; page++) {
        const r = await this.call("user.getRecentTracks", { user, limit: 200, page });
        for (const t of arr(r?.recenttracks?.track) as any[]) {
          addSong(t.artist?.["#text"] ?? t.artist?.name ?? "", t.name ?? "", "Played recently");
        }
      }
    }
    if (o.loved) {
      if (this.cfg.syncLoved) await this.syncLoved().catch(() => {});
      for (const s of Object.values(this.loved)) addSong(s.artist, s.title, "Loved");
    }
    if (o.top) {
      const r = await this.call("user.getTopTracks", { user, period: o.period, limit: 100 });
      for (const t of arr(r?.toptracks?.track) as any[]) addSong(t.artist?.name ?? "", t.name ?? "", "Top song", num(t.playcount));
    }
    if (o.albums) {
      const r = await this.call("user.getTopAlbums", { user, period: o.period, limit: 40 });
      for (const a of arr(r?.topalbums?.album) as any[]) {
        const artist = a.artist?.name ?? "";
        const title = a.name ?? "";
        if (!artist || !title) continue;
        const key = "a:" + albumKey(artist, title);
        out.set(key, {
          key,
          kind: "album",
          artist,
          title,
          reason: "Top album",
          plays: num(a.playcount),
          have: this.albumIndex.has(albumKey(artist, title)),
        });
      }
    }
    return [...out.values()];
  }
}

export const lastfm = new LastFm();

scrobbleHooks.start = (t) => lastfm.onStart(t);
scrobbleHooks.listen = (t, ms) => lastfm.onListen(t, ms);
scrobbleHooks.logged = (t, ms, at, dur) => lastfm.onLogged(t, ms, at, dur);
