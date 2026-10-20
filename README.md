# Aurora

**A music player for your own library, on Windows, Linux and Android.** Find any song or album, download it with proper tags and cover art, and play it in a clean, modern player with playlists, listening stats and Last.fm scrobbling. On your phone it plays in the background, from the lock screen and in the car with Android Auto.

**[⬇ Download the latest version](https://github.com/ppcharcoal/aurora/releases/latest)**

> Aurora is in early testing. Expect rough edges, and please [report anything that breaks](https://github.com/ppcharcoal/aurora/issues).

## Features

**Find and download music**
- Search a real music catalog (Deezer, with Apple's catalog as a fallback), so results are actual songs and albums with correct titles, artists and high-resolution covers. YouTube and SoundCloud are one click away for remixes, live sets and independent artists.
- Download single songs or whole albums. Files are tagged with title, artist, album, track number and cover art, and sorted into `Artist - Album` folders.
- Preview a song or a whole album before downloading.
- Aurora picks the best upload for each song (official audio, matching length) and skips live, cover and sped-up versions unless you asked for them.
- Songs you already have aren't downloaded twice, and the same song in your library twice is shown once.

**Play**
- Your existing music folders work too: MP3, FLAC, M4A/AAC, OGG, Opus and WAV.
- Playlists with drag-to-reorder and custom covers, a play queue with shuffle and repeat, and albums built from your tags.
- **Transitions between songs**, like a DJ mix: *None*, or *Smooth* (skips silent endings and crossfades into the next song). On Windows and Linux, playlists and albums also get a **transition editor**: both whole songs on a zoomable timeline, a playhead you can place anywhere to listen from, drag where the next song comes in, and lines you shape with your own points for volume and effects: **Dampen** (muffle), **Bass** and **Treble** (with undo). Your music files are never changed. Phones get None and Smooth (a fade out and in).
- Choose the audio output (speakers, headphones, Bluetooth, USB DAC) inside the app.
- A look that follows the music: the accent colour comes from the cover art, with dark, light and system themes and a choice of backgrounds.
- **Visualizer**: click (or tap) the playing song's cover for a full-screen visualizer in the spirit of the classic Windows Media Player ones: *Aurora*, *Spectrum*, *Halo*, *Ambience* and *Tunnel*, all reacting to the music in the cover's colours.

**Keep track**
- Profiles for everyone in the house, each with its own playlists, settings and listening stats: total time, a 14-day chart, top songs and artists.
- **Last.fm**: scrobbling, "now playing", loved songs synced both ways, friends' listening, recommendations on Home, radio from any song, artist info, and downloading what you've played elsewhere.
- One-file **backup and restore**: music, profiles, playlists and stats, between PCs and phones in either direction.

**Discord** (Windows and Linux)
- **Your own music bot**: a bot you create (free, about 3 minutes) joins a voice channel and becomes Aurora's speaker there: play, pause, skip and volume in Aurora control the music in the call, and your computer stays quiet while the bot is in the channel.
- **Discord status**: "Listening to" with the song, artist and time left on your profile (optional, in Settings).

**On Android**
- Background playback with notification, lock-screen and Bluetooth controls.
- **Android Auto**: browse Recent, Playlists, Albums and Songs in the car, or ask for music by voice.
- Adds the music already on your phone, and saves downloads to `Download/Aurora`.
- **Space saver** (Settings → Downloads): downloads YouTube's smallest stream, about a third of the size.

## Install

### Windows 10 / 11

1. Download `Aurora-…-windows-setup.exe` from the [latest release](https://github.com/ppcharcoal/aurora/releases/latest) and run it.
2. If Windows shows **"Windows protected your PC"**, click **More info → Run anyway**. The installer isn't signed with a paid certificate, so Windows doesn't recognise it yet.
3. Aurora installs for your user only (no admin rights needed) and appears in the Start menu. The first time you search, it offers to download the tools it needs (yt-dlp and FFmpeg, about 150 MB).

### Linux

The Linux app is built with Electron, so it draws with Chromium: smooth on NVIDIA and AMD, native on Wayland (Hyprland, Sway, GNOME, KDE) and at your monitor's full refresh rate.

**Arch Linux (and Manjaro, EndeavourOS…)**: install it as a normal package with the `PKGBUILD` from the release. It pulls in everything Aurora needs (yt-dlp, FFmpeg, Deno and mutagen for tagging):

```sh
mkdir -p ~/aurora-pkg && cd ~/aurora-pkg
curl -LO https://github.com/ppcharcoal/aurora/releases/latest/download/PKGBUILD
makepkg -si
```

Then start **Aurora** from your app launcher (wofi, rofi, fuzzel…) or run `aurora`. To update, run the same three commands again; to remove it, `sudo pacman -R aurora-player-bin`. Your music, profiles and playlists stay in `~/.local/share/app.aurora.player` either way.

**Hyprland**: Aurora works as a normal tiled window and switches to its compact layout in narrow tiles. A few optional lines for `~/.config/hypr/hyprland.conf`:

```ini
bind = $mainMod, M, exec, aurora                       # open Aurora with Super+M
windowrulev2 = float, class:^(aurora|Aurora)$          # optional: float it instead of tiling
```

Media keys work through MPRIS: bind them to `playerctl play-pause`, `playerctl next` and `playerctl previous`.

**NVIDIA**: use driver 555 or newer (`pacman -Q nvidia-utils`) for smooth Wayland drawing. If the window is black or flickers on an older driver, start Aurora with `AURORA_GPU=0 aurora` to draw without the graphics card.

**Other distributions**: use the `.deb` (Debian, Ubuntu, Mint: `sudo apt install ./Aurora-…-linux-amd64.deb`) or the `.AppImage` (`chmod +x Aurora-…-linux-x86_64.AppImage`, then run it). Also install **yt-dlp**, **FFmpeg** and **Deno** (or Node.js) from your package manager; Aurora tells you if one is missing.

Audio output: choose speakers, headphones or Bluetooth in **Settings → Audio output**, or leave it on *System default* to follow your desktop's sound settings.

### Android 7 or newer

1. On your phone, download `Aurora-…-android.apk` from the [latest release](https://github.com/ppcharcoal/aurora/releases/latest) and open it.
2. Allow **"Install unknown apps"** for your browser or Files app when asked. If Play Protect warns about an unknown app, choose **More details → Install anyway**.
3. Updates install over the old version and keep your music and settings.

**Android Auto** only shows apps from outside the Play Store after a one-time switch. In the Android Auto settings on your phone, tap **Version** ten times to unlock developer settings, then in the **⋮** menu → **Developer settings** turn on **Unknown sources**.

### Last.fm

Last.fm is optional. Go to **You → Connections → Last.fm** and sign in with your Last.fm account. If the app asks for an API key, the build you have doesn't include one: create a free key at [last.fm/api/account/create](https://www.last.fm/api/account/create) and paste it there.

### Discord bot

On Windows and Linux, open **Discord** in Aurora's menu (under Downloads). The page walks you through it; in short:

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and sign in with your Discord account.
2. **New Application** → name it (e.g. *Aurora*, the name people see) → **Create**.
3. **Bot** (left menu) → **Reset Token** → **Yes, do it!** → **Copy**. The three "Privileged Gateway Intents" switches can stay off.
4. Paste the token into Aurora and click **Connect bot**.
5. Click **Add to a server**, choose your server and **Authorize**. Then pick a voice channel in Aurora, press **Join** and play something. The bot only makes sound while Aurora is playing, and Aurora's own speakers stay quiet until the bot leaves.

The bot runs inside Aurora on your computer, so it's online while Aurora is open. Keep the token secret: it's like a password for the bot. Aurora stores it only on your computer and never puts it in backups; if it leaks, reset it in the portal and paste the new one.

For **Discord status** ("Listening to" on your profile): Settings → Discord status. It needs the Discord desktop app running on the same computer, and uses your bot's application (or any application you create in the portal; copy its *Application ID*).

## Please use it fairly

Aurora downloads from YouTube and SoundCloud, whose terms generally don't allow downloading except where they offer it. Use it for music you have the right to keep: your own uploads, Creative Commons and royalty-free music, or tracks you've bought. You're responsible for what you download.

## Building it yourself

Aurora is built with [Tauri 2](https://tauri.app) (Rust) and [Svelte 5](https://svelte.dev). On Windows and Android it uses the system's web view, so it stays small and light; on Linux the same interface runs in [Electron](https://www.electronjs.org), with the same Rust code as a background helper. Downloads use [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FFmpeg](https://ffmpeg.org) on Windows, and [NewPipe Extractor](https://github.com/TeamNewPipe/NewPipeExtractor) on Android.

See **[docs/BUILDING.md](docs/BUILDING.md)** for building both apps, publishing releases, setting up the Last.fm key, and how the code is organised.

## License

[MIT](LICENSE) © 2026 ppcharcoal
