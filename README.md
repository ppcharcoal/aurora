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
- Choose the audio output (speakers, headphones, Bluetooth, USB DAC) inside the app.
- A look that follows the music: the accent colour comes from the cover art, with dark, light and system themes and a choice of backgrounds.
- **Visualizer**: click (or tap) the playing song's cover for a full-screen visualizer in the spirit of the classic Windows Media Player ones: *Aurora*, *Spectrum*, *Halo* and *Ambience*, all reacting to the music in the cover's colours.

**Keep track**
- Profiles for everyone in the house, each with its own playlists, settings and listening stats: total time, a 14-day chart, top songs and artists.
- **Last.fm**: scrobbling, "now playing", loved songs synced both ways, friends' listening, recommendations on Home, radio from any song, artist info, and downloading what you've played elsewhere.
- One-file **backup and restore**: music, profiles, playlists and stats, between PCs and phones in either direction.

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

**Arch Linux (and Manjaro, EndeavourOS…)**: install it as a normal package with the `PKGBUILD` from the release. It pulls in everything Aurora needs (WebKitGTK, GStreamer codecs, yt-dlp, FFmpeg and Deno):

```sh
mkdir -p ~/aurora-pkg && cd ~/aurora-pkg
curl -LO https://github.com/ppcharcoal/aurora/releases/latest/download/PKGBUILD
makepkg -si
```

Then start **Aurora** from your app launcher (wofi, rofi, fuzzel…) or run `aurora`. To update, run the same three commands again; to remove it, `sudo pacman -R aurora-player-bin`.

**Hyprland**: Aurora works as a normal tiled window and switches to its compact layout in narrow tiles. A few optional lines for `~/.config/hypr/hyprland.conf`:

```ini
bind = $mainMod, M, exec, aurora                                    # open Aurora with Super+M
windowrulev2 = float, class:^(aurora|Aurora|app\.aurora\.player)$   # optional: float it instead of tiling
```

`hyprctl clients` shows Aurora's exact window class while it's open. If `playerctl -l` lists Aurora, your media keys can control it with the usual `playerctl play-pause` binds.

Aurora turns off WebKitGTK's DMA-BUF renderer by itself: with it, playback used far more CPU (lag, stuttering music) and NVIDIA could show a blank window. To try it anyway, start Aurora with `AURORA_DMABUF=1 aurora`. If the window is blank, start it with `WEBKIT_DISABLE_COMPOSITING_MODE=1 aurora`.

**Other distributions**: use the `.deb` (Debian, Ubuntu, Mint: `sudo apt install ./Aurora-…-linux-amd64.deb`) or the `.AppImage` (`chmod +x Aurora-…-linux-x86_64.AppImage`, then run it). Also install **yt-dlp**, **FFmpeg** and **Deno** (or Node.js) from your package manager; Aurora tells you if one is missing.

Audio output: Aurora plays through your system's default output. To send it elsewhere, use your desktop's sound menu or **pavucontrol** → Playback.

### Android 7 or newer

1. On your phone, download `Aurora-…-android.apk` from the [latest release](https://github.com/ppcharcoal/aurora/releases/latest) and open it.
2. Allow **"Install unknown apps"** for your browser or Files app when asked. If Play Protect warns about an unknown app, choose **More details → Install anyway**.
3. Updates install over the old version and keep your music and settings.

**Android Auto** only shows apps from outside the Play Store after a one-time switch. In the Android Auto settings on your phone, tap **Version** ten times to unlock developer settings, then in the **⋮** menu → **Developer settings** turn on **Unknown sources**.

### Last.fm

Last.fm is optional. Go to **You → Connections → Last.fm** and sign in with your Last.fm account. If the app asks for an API key, the build you have doesn't include one: create a free key at [last.fm/api/account/create](https://www.last.fm/api/account/create) and paste it there.

## Please use it fairly

Aurora downloads from YouTube and SoundCloud, whose terms generally don't allow downloading except where they offer it. Use it for music you have the right to keep: your own uploads, Creative Commons and royalty-free music, or tracks you've bought. You're responsible for what you download.

## Building it yourself

Aurora is built with [Tauri 2](https://tauri.app) (Rust) and [Svelte 5](https://svelte.dev). It uses the system's web view, so it stays small and light. Downloads use [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FFmpeg](https://ffmpeg.org) on Windows, and [NewPipe Extractor](https://github.com/TeamNewPipe/NewPipeExtractor) on Android.

See **[docs/BUILDING.md](docs/BUILDING.md)** for building both apps, publishing releases, setting up the Last.fm key, and how the code is organised.

## License

[MIT](LICENSE) © 2026 ppcharcoal
