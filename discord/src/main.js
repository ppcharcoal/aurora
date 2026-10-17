// Aurora's Discord bot. Aurora starts this helper when you connect your bot
// (Discord page) and talks to it with one JSON object per line:
//
//   Aurora → helper (stdin):  {"t":"start","token":"…","ffmpeg":"…","control":"voice","nowPlaying":true}
//                             {"t":"join","guildId":"…","channelId":"…"} / {"t":"leave"}
//                             {"t":"play","path":"…","offsetMs":0,"title":"…",…} / pause / resume / seek / stop / volume
//                             {"t":"nowPlaying",…} / {"t":"reply","id":1,"text":"…"} / {"t":"settings",…}
//   helper → Aurora (stdout): ready / guilds / state / command / error / log
//
// Aurora's own player stays in charge (queue, shuffle, what plays next); the
// bot plays the same song from the file, so the sound in the call is clean.
// Commands typed in Discord (/play, /skip…) are passed to Aurora to carry out.

"use strict";

const {
  ActionRowBuilder,
  ActivityType,
  ApplicationCommandOptionType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
} = require("discord.js");
const voice = require("@discordjs/voice");
const { spawn } = require("node:child_process");
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

const COMMANDS = [
  {
    name: "play",
    description: "Play a song or album from the host's Aurora library",
    options: [{ name: "song", description: "Song, artist or album", type: ApplicationCommandOptionType.String, required: true, autocomplete: true }],
  },
  {
    name: "add",
    description: "Add a song to the end of the queue",
    options: [{ name: "song", description: "Song, artist or album", type: ApplicationCommandOptionType.String, required: true, autocomplete: true }],
  },
  { name: "pause", description: "Pause the music" },
  { name: "resume", description: "Carry on playing" },
  { name: "skip", description: "Skip to the next song" },
  { name: "previous", description: "Go back to the previous song" },
  { name: "np", description: "What's playing now" },
  { name: "queue", description: "The next songs" },
  { name: "join", description: "Bring the bot into your voice channel" },
  { name: "leave", description: "Stop the music and leave the voice channel" },
];

const s = {
  client: null,
  ffmpeg: "ffmpeg",
  control: "voice", // "voice" | "everyone" | "owner" | "none"
  nowPlaying: true,
  owners: new Set(),
  conn: null,
  guildId: null,
  channelId: null,
  player: voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Play } }),
  proc: null,
  track: null, // what Aurora is playing: { path, title, artist, album, durationMs, cover }
  offsetMs: 0, // where the current ffmpeg run started in the song
  resource: null,
  paused: false,
  volume: 1,
  npMessage: null,
  pending: new Map(), // reply id → resolve
  nextId: 1,
  restartTimer: null,
};

// ---------------------------------------------------------------- audio ----

function position() {
  return s.offsetMs + (s.resource ? s.resource.playbackDuration : 0);
}

function killFfmpeg() {
  if (s.proc) {
    s.proc.removeAllListeners();
    try {
      s.proc.kill("SIGKILL");
    } catch {}
    s.proc = null;
  }
}

/** Starts (or restarts) the song at `ms`; ffmpeg turns the file into Opus for Discord. */
function startAt(ms) {
  killFfmpeg();
  if (!s.track) return;
  if (!fs.existsSync(s.track.path)) return fail(`The file isn't there any more: ${s.track.path}`, "file");
  const gain = Math.max(0, Math.min(2, s.volume));
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-ss", (Math.max(0, ms) / 1000).toFixed(3),
    "-i", s.track.path,
    "-vn", "-af", `volume=${(gain * gain).toFixed(3)}`,
    "-ac", "2", "-ar", "48000",
    "-c:a", "libopus", "-b:a", "128k", "-frame_duration", "20", "-application", "audio",
    "-f", "ogg", "pipe:1",
  ];
  const proc = spawn(s.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  s.proc = proc;
  let err = "";
  proc.stderr.on("data", (d) => (err = (err + d).slice(-600)));
  proc.on("error", (e) => fail(`FFmpeg couldn't start (${e.message}). Install FFmpeg, or let Aurora install its tools.`, "ffmpeg"));
  proc.on("close", (code) => {
    if (code && s.proc === proc) fail(`FFmpeg stopped: ${err.trim() || "code " + code}`, "ffmpeg");
  });
  s.offsetMs = Math.max(0, ms);
  s.resource = voice.createAudioResource(proc.stdout, { inputType: voice.StreamType.OggOpus });
  s.player.play(s.resource);
  if (s.paused) s.player.pause(true);
  report();
}

function restartSoon() {
  clearTimeout(s.restartTimer);
  s.restartTimer = setTimeout(() => {
    if (s.track && s.proc) startAt(position());
  }, 250);
}

s.player.on(voice.AudioPlayerStatus.Idle, () => {
  s.resource = null;
  report();
});
s.player.on("error", (e) => log(`player: ${e.message}`));

function stopAudio() {
  killFfmpeg();
  s.track = null;
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

function buttons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("aurora:previous").setEmoji("⏮️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("aurora:toggle").setEmoji("⏯️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("aurora:skip").setEmoji("⏭️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("aurora:leave").setEmoji("⏹️").setStyle(ButtonStyle.Danger),
  );
}

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
    s.npMessage = await channel.send({ embeds: [embed], files, components: [buttons()], flags: MessageFlags.SuppressNotifications });
  } catch (e) {
    log(`now-playing message: ${e.message}`);
  }
}

// ------------------------------------------------------------- commands ----

function allowed(member, user) {
  if (s.control === "none") return false;
  if (s.control === "everyone") return true;
  if (s.control === "owner") return s.owners.has(user.id);
  // "voice": people listening in the bot's channel (or anyone while it isn't in one)
  if (s.owners.has(user.id)) return true;
  if (!s.conn) return true;
  return member?.voice?.channelId === s.channelId;
}

/** Asks Aurora to do something; resolves with its answer (or a timeout message). */
function ask(cmd, args, user) {
  const id = s.nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      s.pending.delete(id);
      resolve({ text: "Aurora didn't answer. Is it still open?" });
    }, 8000);
    s.pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    send({ t: "command", id, cmd, args: args ?? {}, user: user ? { id: user.id, name: user.globalName ?? user.username } : null });
  });
}

const denied = () =>
  s.control === "none"
    ? "This bot is controlled from Aurora only."
    : s.control === "owner"
      ? "Only the bot's owner can control the music."
      : "Join the bot's voice channel to control the music.";

async function onInteraction(i) {
  try {
    if (i.isAutocomplete()) {
      if (!allowed(i.member, i.user)) return i.respond([]);
      const q = String(i.options.getFocused() ?? "");
      const r = await Promise.race([ask("search", { query: q }), new Promise((ok) => setTimeout(() => ok({ items: [] }), 2500))]);
      return i.respond((r.items ?? []).slice(0, 25).map((x) => ({ name: String(x.name).slice(0, 100), value: String(x.value).slice(0, 100) })));
    }
    if (i.isButton() && i.customId.startsWith("aurora:")) {
      if (!allowed(i.member, i.user)) return i.reply({ content: denied(), flags: MessageFlags.Ephemeral });
      await i.deferUpdate();
      const cmd = i.customId.slice(7);
      if (cmd === "leave") {
        await ask("stop", {}, i.user);
        leave();
      } else await ask(cmd, {}, i.user);
      return;
    }
    if (!i.isChatInputCommand()) return;
    if (!allowed(i.member, i.user)) return i.reply({ content: denied(), flags: MessageFlags.Ephemeral });
    const name = i.commandName;
    if (name === "join") {
      const ch = i.member?.voice?.channel;
      if (!ch) return i.reply({ content: "Join a voice channel first, then use /join.", flags: MessageFlags.Ephemeral });
      await i.deferReply();
      await join(i.guildId, ch.id);
      return i.editReply(s.conn ? `Joined **${ch.name}**. Use /play to pick music, or play something in Aurora.` : "Couldn't join that channel.");
    }
    if (name === "leave") {
      await ask("stop", {}, i.user);
      leave();
      return i.reply("Left the voice channel. 👋");
    }
    const ephemeral = name === "np" || name === "queue";
    await i.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
    if ((name === "play" || name === "add") && !s.conn) {
      const ch = i.member?.voice?.channel;
      if (ch) await join(i.guildId, ch.id);
    }
    const r = await ask(name, { query: i.options.getString("song") ?? "" }, i.user);
    await i.editReply(String(r.text ?? "Done.").slice(0, 1900));
  } catch (e) {
    log(`interaction: ${e.message}`);
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

async function registerCommands(guild) {
  try {
    await guild.commands.set(COMMANDS);
  } catch (e) {
    log(`commands in ${guild.name}: ${e.message}`);
  }
}

async function start(m) {
  s.ffmpeg = m.ffmpeg || "ffmpeg";
  applySettings(m);
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  s.client = client;
  client.once(Events.ClientReady, async (c) => {
    try {
      const app = await c.application.fetch();
      const owner = app.owner;
      if (owner?.members) for (const id of owner.members.keys()) s.owners.add(id);
      else if (owner?.id) s.owners.add(owner.id);
    } catch {}
    send({
      t: "ready",
      user: { id: c.user.id, name: c.user.username, avatar: c.user.displayAvatarURL({ size: 128, extension: "png" }) },
      appId: c.application.id,
      invite: `https://discord.com/oauth2/authorize?client_id=${c.application.id}&scope=bot+applications.commands&permissions=${PERMISSIONS}`,
      guilds: guildList(),
    });
    for (const g of c.guilds.cache.values()) registerCommands(g);
  });
  client.on(Events.GuildCreate, (g) => {
    registerCommands(g);
    sendGuilds();
  });
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
  client.on(Events.InteractionCreate, onInteraction);
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
  if (m.control) s.control = m.control;
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
      s.track = { path: m.path, title: m.title || path.basename(m.path), artist: m.artist ?? "", album: m.album ?? "", durationMs: m.durationMs ?? 0, cover: m.cover ?? null, color: m.color ?? null };
      s.paused = !!m.paused;
      if (typeof m.volume === "number") s.volume = m.volume;
      startAt(m.offsetMs ?? 0);
      setActivity();
      if (!same || !s.npMessage) postNowPlaying();
      return;
    }
    case "pause":
      s.paused = true;
      s.player.pause(true);
      setActivity();
      return report();
    case "resume":
      s.paused = false;
      if (s.track && !s.proc) startAt(m.positionMs ?? s.offsetMs);
      else s.player.unpause();
      setActivity();
      return report();
    case "seek":
      if (s.track) startAt(m.positionMs ?? 0);
      return;
    case "stop":
      return stopAudio();
    case "volume":
      s.volume = typeof m.volume === "number" ? m.volume : 1;
      return restartSoon();
    case "reply": {
      const done = s.pending.get(m.id);
      if (done) {
        s.pending.delete(m.id);
        done(m);
      }
      return;
    }
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
