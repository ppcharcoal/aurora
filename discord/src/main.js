// Aurora's Discord bot. Aurora starts this helper when you connect your bot
// (Discord page) and talks to it with one JSON object per line:
//
//   Aurora → helper (stdin):  {"t":"start","token":"…","ffmpeg":"…","nowPlaying":true}
//                             {"t":"join","guildId":"…","channelId":"…"} / {"t":"leave"}
//                             {"t":"play","path":"…","offsetMs":0,"title":"…",…} / pause / resume / seek / stop / volume
//                             {"t":"settings",…} / {"t":"quit"}
//   helper → Aurora (stdout): ready / guilds / state / error / log
//
// Aurora's player is in charge (queue, play/pause, volume); the bot is its
// speaker in the call and plays the same song straight from the file. The bot
// only makes sound while Aurora is playing.

"use strict";

const {
  ActivityType,
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
} = require("discord.js");
const voice = require("@discordjs/voice");
const { Session } = require("./mixer.js");
const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline");

// stdout is the line protocol: everything else goes to stderr.
const out = process.stdout;
console.log = console.info = console.debug = (...a) => process.stderr.write(a.join(" ") + "\n");
const send = (msg) => out.write(JSON.stringify(msg) + "\n");
const log = (message) => send({ t: "log", message: String(message) });
const fail = (message, code) => send({ t: "error", message: String(message), code });

/** Permissions the invite link asks for: see channels, send messages with covers, connect and speak. */
const PERMISSIONS = 1024n + 2048n + 16384n + 32768n + 1048576n + 2097152n;

const s = {
  client: null,
  ffmpeg: "ffmpeg",
  nowPlaying: true,
  conn: null,
  guildId: null,
  channelId: null,
  player: voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Play } }),
  session: null, // the mixer playing right now (mixer.js)
  track: null, // what Aurora is playing: { path, title, artist, album, durationMs, cover }
  next: null, // { track, mix }: how to go into the next song
  offsetMs: 0, // where the song is (while paused) or was started
  resource: null,
  paused: false,
  volume: 1,
  npMessage: null,
};

// ---------------------------------------------------------------- audio ----

/** What Discord is hearing right now: the song and the position in it (ms). */
function heard() {
  if (!s.session || !s.resource) return { track: s.track, ms: s.offsetMs };
  return s.session.heard(s.resource.playbackDuration);
}
const position = () => heard().ms;

// When the bot has gone into the next song by itself (a transition), show it once it's heard.
setInterval(() => {
  const h = heard();
  if (!s.session || !h.track || !s.track || h.track.path === s.track.path) return;
  s.track = h.track;
  setActivity();
  postNowPlaying();
  report();
}, 250).unref();

function endSession() {
  if (s.session) {
    s.session.stop();
    s.session = null;
  }
}

const toTrack = (m) =>
  m && m.path
    ? { path: m.path, title: m.title || path.basename(m.path), artist: m.artist ?? "", album: m.album ?? "", durationMs: m.durationMs ?? 0, cover: m.cover ?? null, color: m.color ?? null }
    : null;
/** Aurora's plan for the next song: { track, mix } (mix: the transition, as in the app). */
const toNext = (n) => (n && n.path && n.mix ? { track: toTrack(n), mix: n.mix } : null);

/** (Re)starts playing the current song at `ms`, with the transition into the next one (see mixer.js). */
function startAt(ms) {
  endSession();
  if (!s.track) return;
  s.offsetMs = Math.max(0, ms);
  if (s.paused) {
    // Paused in Aurora: stay silent until it plays again.
    s.resource = null;
    s.player.stop(true);
    return report();
  }
  if (!fs.existsSync(s.track.path)) return fail(`The file isn't there any more: ${s.track.path}`, "file");
  const session = new Session({
    ffmpeg: s.ffmpeg,
    track: s.track,
    fromMs: s.offsetMs,
    // Only a plan that starts from this song.
    next: s.next && (!s.nextFrom || s.nextFrom === s.track.path) ? s.next : null,
    volume: s.volume,
    onError: (e) => fail(e, "ffmpeg"),
  });
  s.session = session;
  s.resource = voice.createAudioResource(session.ogg, { inputType: voice.StreamType.OggOpus });
  s.player.play(s.resource);
  report();
}

s.player.on(voice.AudioPlayerStatus.Idle, () => {
  s.resource = null;
  report();
});
s.player.on("error", (e) => log(`player: ${e.message}`));

function stopAudio() {
  endSession();
  s.track = null;
  s.next = null;
  s.resource = null;
  s.player.stop(true);
  setActivity();
  report();
}

// ---------------------------------------------------------------- voice ----

function report() {
  const st = s.player.state.status;
  send({
    t: "state",
    voice: s.conn ? (s.conn.state.status === voice.VoiceConnectionStatus.Ready ? "connected" : "connecting") : "off",
    guildId: s.guildId,
    channelId: s.channelId,
    playing: st === voice.AudioPlayerStatus.Playing,
    paused: s.paused,
    positionMs: Math.round(position()),
    title: s.track?.title ?? null,
    path: s.track?.path ?? null,
  });
}
setInterval(() => s.conn && report(), 2000).unref();

async function join(guildId, channelId) {
  const guild = s.client?.guilds.cache.get(guildId);
  const channel = guild?.channels.cache.get(channelId);
  if (!guild || !channel) return fail("That server or voice channel isn't available to the bot.", "join");
  const me = guild.members.me;
  const perms = me && channel.permissionsFor(me);
  if (perms && (!perms.has("Connect") || !perms.has("Speak") || !perms.has("ViewChannel"))) {
    return fail(`The bot isn't allowed to connect and speak in “${channel.name}”. In Discord: channel settings → Permissions → give the bot (or its role) View Channel, Connect and Speak.`, "perm");
  }
  if (s.conn && s.guildId === guildId && s.channelId === channelId && s.conn.state.status !== voice.VoiceConnectionStatus.Destroyed) return report();
  leave(false);
  s.guildId = guildId;
  s.channelId = channelId;
  const conn = voice.joinVoiceChannel({ guildId, channelId, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
  s.conn = conn;
  conn.subscribe(s.player);
  report();
  conn.on("stateChange", (_o, n) => {
    if (s.conn !== conn) return;
    report();
    if (n.status === voice.VoiceConnectionStatus.Disconnected) {
      // Moved to another channel → reconnects by itself; kicked → give up.
      Promise.race([
        voice.entersState(conn, voice.VoiceConnectionStatus.Signalling, 5000),
        voice.entersState(conn, voice.VoiceConnectionStatus.Connecting, 5000),
      ]).catch(() => {
        if (s.conn === conn) {
          leave(false);
          report();
        }
      });
    }
  });
  conn.on("error", (e) => log(`voice: ${e.message}`));
  try {
    await voice.entersState(conn, voice.VoiceConnectionStatus.Ready, 20000);
    // Follow the channel if someone drags the bot elsewhere.
    s.channelId = conn.joinConfig.channelId;
    report();
  } catch {
    if (s.conn === conn) {
      leave(false);
      fail("Couldn't connect to the voice channel (Discord didn't answer in 20 s). Try again.", "join");
    }
  }
}

function leave(reportIt = true) {
  if (s.conn) {
    const c = s.conn;
    s.conn = null;
    try {
      c.destroy();
    } catch {}
  }
  if (s.npMessage) {
    s.npMessage.delete().catch(() => {});
    s.npMessage = null;
  }
  if (reportIt) report();
}

// ------------------------------------------------------------- messages ----

function setActivity() {
  const u = s.client?.user;
  if (!u) return;
  if (s.track && !s.paused) u.setActivity(`${s.track.title}${s.track.artist ? " – " + s.track.artist : ""}`.slice(0, 120), { type: ActivityType.Listening });
  else u.setActivity(null);
}

const fmt = (ms) => {
  const t = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/** Posts the song card in the voice channel's chat (replacing the last one). */
async function postNowPlaying() {
  if (!s.nowPlaying || !s.track || !s.conn || !s.client) return;
  const channel = s.client.channels.cache.get(s.channelId);
  if (!channel?.isTextBased?.()) return;
  const t = s.track;
  const embed = new EmbedBuilder()
    .setColor(t.color ?? 0x7c5cff)
    .setAuthor({ name: "Now playing in Aurora" })
    .setTitle(t.title.slice(0, 250))
    .setDescription([t.artist, t.album].filter(Boolean).join(" · ").slice(0, 500) || null)
    .setFooter({ text: t.durationMs ? fmt(t.durationMs) : "Aurora" });
  const files = [];
  if (t.cover && fs.existsSync(t.cover) && fs.statSync(t.cover).size < 8_000_000) {
    const name = "cover" + (path.extname(t.cover).toLowerCase() || ".jpg");
    files.push(new AttachmentBuilder(t.cover, { name }));
    embed.setThumbnail(`attachment://${name}`);
  }
  const old = s.npMessage;
  s.npMessage = null;
  if (old) old.delete().catch(() => {});
  try {
    s.npMessage = await channel.send({ embeds: [embed], files, flags: MessageFlags.SuppressNotifications });
  } catch (e) {
    log(`now-playing message: ${e.message}`);
  }
}

// ---------------------------------------------------------------- start ----

function guildList() {
  return [...(s.client?.guilds.cache.values() ?? [])]
    .map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.iconURL({ size: 64, extension: "png" }),
      channels: [...g.channels.cache.values()]
        .filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .map((c) => ({ id: c.id, name: c.name, listeners: c.members.filter((m) => !m.user.bot).size })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
const sendGuilds = () => send({ t: "guilds", guilds: guildList() });

/** Aurora 0.5.0 added slash commands; the bot is controlled from Aurora only now, so remove them. */
async function clearCommands(guild) {
  try {
    if ((await guild.commands.fetch()).size) await guild.commands.set([]);
  } catch {}
}

async function start(m) {
  s.ffmpeg = m.ffmpeg || "ffmpeg";
  applySettings(m);
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  s.client = client;
  client.once(Events.ClientReady, async (c) => {
    send({
      t: "ready",
      user: { id: c.user.id, name: c.user.username, avatar: c.user.displayAvatarURL({ size: 128, extension: "png" }) },
      appId: c.application.id,
      invite: `https://discord.com/oauth2/authorize?client_id=${c.application.id}&scope=bot+applications.commands&permissions=${PERMISSIONS}`,
      guilds: guildList(),
    });
    for (const g of c.guilds.cache.values()) clearCommands(g);
    c.application.commands.set([]).catch(() => {});
  });
  client.on(Events.GuildCreate, () => sendGuilds());
  client.on(Events.GuildDelete, (g) => {
    if (g.id === s.guildId) leave();
    sendGuilds();
  });
  for (const ev of [Events.ChannelCreate, Events.ChannelDelete, Events.ChannelUpdate, Events.GuildUpdate]) client.on(ev, sendGuilds);
  let vsTimer;
  client.on(Events.VoiceStateUpdate, (o, n) => {
    clearTimeout(vsTimer);
    vsTimer = setTimeout(sendGuilds, 500);
    // Discord moved the bot, or someone disconnected it.
    if (n.id === client.user?.id && n.guild.id === s.guildId) {
      if (n.channelId && n.channelId !== s.channelId) {
        s.channelId = n.channelId;
        report();
      }
    }
  });
  client.on("error", (e) => log(`client: ${e.message}`));
  client.on(Events.ShardDisconnect, () => send({ t: "offline" }));
  client.on(Events.ShardResume, () => sendGuilds());
  try {
    await client.login(m.token);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/token/i.test(msg) || e?.code === "TokenInvalid") fail("Discord didn't accept this token. Copy it again from the Developer Portal (Bot → Reset Token) and paste the new one.", "token");
    else if (/intent/i.test(msg)) fail("Discord refused the bot's settings: " + msg, "token");
    else fail("Couldn't reach Discord: " + msg, "network");
    setTimeout(() => process.exit(0), 200);
  }
}

function applySettings(m) {
  if (typeof m.nowPlaying === "boolean") {
    s.nowPlaying = m.nowPlaying;
    if (!s.nowPlaying && s.npMessage) {
      s.npMessage.delete().catch(() => {});
      s.npMessage = null;
    }
  }
}

function handle(m) {
  switch (m.t) {
    case "start":
      return start(m);
    case "settings":
      return applySettings(m);
    case "join":
      return join(m.guildId, m.channelId);
    case "leave":
      stopAudio();
      return leave();
    case "play": {
      const same = s.track && s.track.path === m.path;
      s.track = toTrack(m);
      s.next = toNext(m.next);
      s.nextFrom = m.path;
      s.paused = !!m.paused;
      if (typeof m.volume === "number") s.volume = m.volume;
      startAt(m.offsetMs ?? 0);
      setActivity();
      if (!s.paused && (!same || !s.npMessage)) postNowPlaying();
      return;
    }
    case "next":
      // What comes after the current song changed (queue, transitions…).
      s.next = toNext(m.next);
      s.nextFrom = m.from ?? null;
      s.session?.setNext(s.next, m.from);
      return;
    case "pause":
      // Stop the sound (not just pause the stream): reliable even mid-buffering.
      if (!s.paused) s.offsetMs = typeof m.positionMs === "number" ? m.positionMs : position();
      s.paused = true;
      startAt(s.offsetMs);
      setActivity();
      return;
    case "resume":
      s.paused = false;
      startAt(typeof m.positionMs === "number" ? m.positionMs : s.offsetMs);
      setActivity();
      if (!s.npMessage) postNowPlaying();
      return;
    case "seek":
      if (s.track) startAt(m.positionMs ?? 0);
      return;
    case "stop":
      return stopAudio();
    case "volume":
      // Instant: the mixer applies it to the next 20 ms.
      s.volume = typeof m.volume === "number" ? m.volume : 1;
      s.session?.setVolume(s.volume);
      return;
    case "quit":
      return quit();
  }
}

function quit() {
  stopAudio();
  leave(false);
  s.client?.destroy().catch?.(() => {});
  setTimeout(() => process.exit(0), 300);
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  Promise.resolve()
    .then(() => handle(m))
    .catch((e) => fail(e?.message ?? e));
});
// Aurora closed (stdin ended): leave the call and stop.
process.stdin.on("end", quit);
process.on("uncaughtException", (e) => fail(`Unexpected error: ${e?.message ?? e}`));
process.on("unhandledRejection", (e) => log(`unhandled: ${e?.message ?? e}`));
send({ t: "hello", version: 1 });
