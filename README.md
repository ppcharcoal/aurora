# Aurora

A fast, good-looking Windows music player for your own files. Search YouTube, download songs or whole albums as tagged MP3s with cover art, organise everything into playlists, keep separate profiles with listening stats, and move it all to another PC with one backup file. No online accounts, no API keys.

Built with [Tauri 2](https://tauri.app) (Rust) and Svelte 5. The app is a few MB and uses the WebView2 runtime that ships with Windows 10/11, so it stays light on memory.

## What it does

- **Music only search** (on by default, toggle next to the search bar): results come from a real music catalog (Deezer's public API, with Apple's iTunes Search API as a fallback), so you only see actual songs and albums, with proper titles, artists and 1000px covers. When you download one, Aurora searches YouTube for that song and scores the uploads (length within a few seconds, official "Topic"/VEVO channels, title match, and it avoids live, cover, remix, sped-up and "1 hour" versions unless you asked for them), then tags the MP3 with the catalog's title, artist and cover.
- **Three sources** (switch next to the search bar): *Music only* (catalog), *YouTube* (anything, incl. remixes and live sets) and *SoundCloud* (independent artists, DJ mixes; SoundCloud Go+ tracks are marked "30-second clip only").
- **Reliable downloads**: temporary errors such as YouTube's "HTTP Error 403" are retried automatically (3 attempts with fresh stream links, plus yt-dlp's own retries). Catalog songs then try the next-best upload, and finally SoundCloud, before giving up.
- **Previews**: the headphones button plays a 30-second preview before you download: catalog clips for Music only, a stream for YouTube/SoundCloud. Albums have "Preview album" (plays every track's preview in a row) and a preview button per track.
- **Size estimates**: every result and album shows its approximate MP3 size for your quality setting; "Download all" in the Last.fm sync tab shows the total. The sidebar shows how much your music takes and how much space is left on that drive (click it to open the folder).
- **Download as MP3**: one click converts to MP3 (best VBR by default, or 320/192/128 kbps, or Space saver below), embeds a square cover from the thumbnail, and tags artist and title (it splits "Artist - Title (Official Video)" for you). Files go to your chosen folder and appear in your library straight away.
- **Space saver** (Settings → Downloads → Quality): keeps YouTube's original audio stream (about 130 kbps Opus) instead of converting it to MP3. Files are roughly half the size of "Best MP3" with no quality lost, because nothing is re-encoded. They're `.opus` files, which Aurora, phones, VLC and foobar2000 play; pick an MP3 setting if you copy music to an older car stereo or iTunes.
- **Audio output** (Settings → Audio output, or the speaker button next to the volume): pick which speakers or headphones play the music; previews follow it too. If that device is unplugged, the default plays until it's back, and Aurora switches back by itself. On Windows the device names appear after a one-time "Show my devices" click: WebView2 only shares them after a quick microphone permission check (nothing is recorded). On a PC without any microphone that check can't run; pick the output for Aurora in Windows Settings → System → Sound → Volume mixer instead.
- **Android app** (see "Android" below): the same app on your phone, with background playback, lock-screen and Bluetooth controls, **Android Auto**, and its own audio-output picker.
- **First-time setup**: a short welcome (your name, a look, Last.fm sign-in, a data limit and where songs go). Every step can be skipped, or the whole thing with "Skip setup". Each new profile gets it too; Settings has "Run the first-time setup again".
- **Data limit** (setup, or Settings → Storage): a slider from 500 MB to 1 TB, or no limit, showing about how many songs fit at Space saver, Best MP3 and 320 kbps, where your current music sits on the scale, and whether the drive has that much room. Downloads that would go over it are held back with a message (retry them after raising the limit), and the sidebar meter shows how full the limit is.
- **One copy of each song** (Settings → Storage, on by default): if the same song is in your library twice (same artist and title, about the same length, e.g. downloaded on the phone and restored from a PC backup), it's listed once, using the best copy (higher bitrate, then the one with album details). Downloads skip songs you already have ("Already in your library"), and album downloads only fetch the missing tracks. *Delete extra copies* removes the other files for good and moves their playlists, history and play counts to the copy that's kept.
- **Storage** (Settings → Storage): "Slim down cover art" re-saves oversized pictures embedded in your MP3s at 600 px (often 100–300 KB per song). The audio is never touched: every file is rewritten as a copy, checked to have byte-for-byte the same audio and the same length, and only then swapped in; anything that doesn't check out is left alone. The playing song is skipped. Nothing happens at play time, so playback isn't slowed down.
- **Download straight into a playlist** with the playlist button next to any result.
- **Albums**: switch Search to *Albums* to find albums on YouTube Music, see the track list, and download the whole album at once. It lands in `Artist - Album\01 - Title.mp3` with album, album artist, track numbers and the album cover, and shows up under Library → Albums. Songs downloaded on their own are standalone and live under Library → Songs.
- **Downloads page**: live progress, speed and time left, cancel, retry, and show in folder. Two downloads run at once.
- **Playlists**: create, rename, delete, drag to reorder, add from the right-click menu anywhere. Covers are a 2×2 mosaic of the songs, or any image from your PC (Aurora keeps its own copy, so deleting the original is fine).
- **Profiles**: as many local profiles as you like, each with its own picture, playlists, recently played, settings and listening stats (total time, today, last 7 days, a 14-day chart, top songs and artists). Only real playback time counts. The music library is shared.
- **Backup and restore** (Settings): one `.zip` with all songs, every profile and its picture, playlists and covers, listening stats, history and settings. Restore it on another PC (or a fresh install): pick where the music should go, and Aurora rewires every playlist and stat to the restored files.
- **Last.fm** (Profile → Connections, each switch optional): scrobbling with "now playing" (Last.fm's rule: after half the song or 4 minutes; cached and retried when offline), loved songs synced both ways (♥ in the dock, Love in any song's menu, a Loved page), Discover on Home (songs by artists similar to what you play), radio from any song (plays similar songs you have and downloads up to 8 you don't), artist bio, tags and picture on album pages, and an all-time history import.
- **Friends**: people you follow on Last.fm, what they're listening to now and their last songs, with preview and one-click download.
- **Sync from Last.fm** (Downloads → From Last.fm): compares what you played recently, loved and played most (anywhere, as long as it was scrobbled) with this PC, finds the missing songs and albums in the catalog, and downloads them. Optionally, songs you love on another device are downloaded automatically.
- **Library**: add any folders you already have (MP3, FLAC, M4A/AAC, OGG, Opus, WAV). Tags are read in parallel, and rescans only touch changed files. Every song shows its own picture: songs with the same artwork (an album) share one cached thumbnail, singles keep theirs, and a song with no picture borrows its album's cover or its YouTube thumbnail.
- **About the artist** (bottom of album pages, with Last.fm): click the card, or "More songs by …", to search for more of that artist's songs.
- **Player**: one queue with shuffle, repeat, play next, and a slide-in queue panel. Media keys and the Windows media overlay work.
- **Look and feel**: floating panels over a living background. The now-playing dock shows the cover as a record sleeve, and the record slides out and spins while the music plays; album cards show their record on hover. Dark, light or match-Windows mode. The background can be the blurred cover art, your own picture (the accent colour is taken from it) or plain. While music plays, the accent follows the cover art, adjusted to stay readable in both modes. "Reduce motion" turns animation off.

Keyboard: `Space` play/pause · `Ctrl+←/→` previous/next · `←/→` seek 5 s · `Ctrl+F` search · `Q` queue · `Alt+←` or the mouse back button to go back · right-click a song for more.

## Build and run

You need, once:

1. **Node.js 20+**: https://nodejs.org
2. **Rust**: https://rustup.rs (`rustup-init.exe`, accept the defaults). If it offers to install the Visual C++ build tools, say yes.
3. Close and reopen your terminal, then check that `cargo --version` works.

### Install it as a normal Windows program

Double-click **`Build installer.cmd`** in this folder. It installs the packages, builds Aurora (the first build takes 5–15 minutes; later ones are much faster) and then starts the installer, `Aurora_0.2.0_x64-setup.exe`. Click through it and Aurora is installed like any other program:

- it's in the **Start menu** (type "Aurora") and the last installer page has a ticked **desktop icon** box; right-click either to pin it to the taskbar;
- it starts without a console window;
- it's listed in **Settings → Apps**, where you can uninstall it;
- it installs for your user only, so no admin rights are needed. Your profiles, playlists and music are kept when you update or reinstall.

The installer itself is in `src-tauri\target\release\bundle\nsis\`. It's one file you can copy to another PC: that PC needs nothing else (no Node, no Rust). To update, build again and run the new installer over the old version.

### Developing

```
npm install
npm run app:dev      # run with hot reload (with a console, for debugging)
npm run app:build    # build the installer (what Build installer.cmd does)
```

## Android

Aurora also builds as an Android app (Android 7 or newer) from the same code. On the phone:

- **Playback runs in a native service** (Media3/ExoPlayer), so music keeps playing with the screen off, shows the usual media notification and lock-screen controls, and works with Bluetooth buttons.
- **Android Auto**: Aurora appears as a media app in the car with tabs for Recent, Playlists, Albums and Songs (plus "Shuffle all"). Picking a song plays the rest of that album or playlist after it, and voice search ("play Daft Punk on Aurora") searches your library. Album art comes from your covers.
- **Audio output**: Settings → Audio output (or the "This phone" button in the full player) lists the phone speaker, wired, Bluetooth and USB devices. The choice is remembered by name, so your Bluetooth headphones are picked again when they reconnect. In the car, Android Auto always plays through the car.
- **Downloads**: there is no yt-dlp or FFmpeg on a phone, so the Android app uses NewPipe Extractor (the library behind the NewPipe app) to search YouTube and SoundCloud and saves the audio as the site serves it, without converting: YouTube as M4A (AAC, about 128 kbps), SoundCloud as MP3. Songs are tagged with cover art like on the PC and saved in **Download/Aurora** (visible in the Files app and over USB; on Android 10 and older they stay in Aurora's own folder). YouTube serves its M4A in fragments; Aurora rebuilds that into an ordinary M4A (the same audio bytes, nothing re-encoded) before tagging. Searching YouTube Music *albums* isn't in the phone version yet; albums from **Music only** work.
- **Stats and Last.fm** also count what you play while the app's screen is closed (in the car, phone locked): the player keeps a log and Aurora adds it when you open the app.
- **Layout**: bottom tabs (Home, Search, Library, Downloads, You), a mini player and a full-screen player you swipe down to close. Loved, Friends and Settings are under You; playlists are a tab in Library.
- **Music already on the phone**: Settings → Library folders → *Add music from this phone* (or the button in an empty Library). Aurora asks once for the "Music and audio" permission, lists the folders Android's music index knows about (Music, Download, …) with their song counts, and adds the ones you tick. The songs are read where they are; nothing is copied. Chat-app and recorder folders are listed but not ticked, since they're mostly voice notes.
- **Backup and restore** work like on Windows: *Create backup* opens Android's "save as" screen (phone storage, an SD card, or Google Drive), *Restore from backup* its "open" screen. A backup from your PC restores onto the phone (the music goes into Download/Aurora and every playlist and stat is pointed at it) and the other way round, so it's the quickest way to move your whole library across. Restoring needs room for the music on the phone.
- **Songs that showed up but played no sound** (downloaded with the first phone version): their audio index pointed at the wrong place after tagging. Open the app once after updating: the library is re-read and those files are repaired in place (only the index numbers change; the audio itself is untouched and checked to decode identically).
- **Pictures** for profiles, playlist covers and theme images come from the phone's picture picker; Aurora keeps its own copy, like on Windows.

### Build the Android app

You need, once, on your PC:

1. **Android Studio** (https://developer.android.com/studio). In its SDK Manager install: *Android SDK Platform 36*, *Android SDK Build-Tools*, *Android SDK Command-line Tools* and *NDK (Side by side)*.
2. Set the environment variables (Windows: search "environment variables"): `JAVA_HOME` = `C:\Program Files\Android\Android Studio\jbr`, `ANDROID_HOME` = `%LOCALAPPDATA%\Android\Sdk`, `NDK_HOME` = `%ANDROID_HOME%\ndk\<version>`. Reopen the terminal.
3. Add the Rust targets: `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android`

Then, in this folder:

```
npm install
npm run android:init      # once: creates src-tauri/gen/android and adds what Aurora needs to it
npm run android:signing   # once: creates Aurora's signing key and signs release builds with it
npm run android:build     # build the app for phones (arm64)
npm run android:dev       # or: run on a phone connected by USB (USB debugging on) or an emulator
```

`android:init` runs `tauri android init` and then `scripts/android-setup.mjs`, which adds the JitPack repository (for NewPipe Extractor) and Java library desugaring to the generated Gradle project, and copies the app icon (`src-tauri/icons/android`, the PC icon laid out for Android's round and squircle icon shapes; `scripts/android-icons.py` regenerates it from `icon.png`). After pulling a new version, run `node scripts/android-setup.mjs` once (it's safe to repeat) instead of a full `android:init`. If it says it couldn't find a spot, add these by hand: `maven("https://jitpack.io")` in `allprojects { repositories { … } }` of `src-tauri/gen/android/build.gradle.kts`, and in `src-tauri/gen/android/app/build.gradle.kts` `isCoreLibraryDesugaringEnabled = true` inside `compileOptions { … }` plus `coreLibraryDesugaring("com.android.tools:desugar_jdk_libs_nio:2.1.5")` in `dependencies { … }`.

The app lands in `src-tauri/gen/android/app/build/outputs/apk/arm64/release/` as `app-arm64-release.apk`. Copy it to the phone and open it (allow "install unknown apps" for your file manager when asked), or install it with `adb install <file>.apk`.

**Keep `src-tauri/aurora-release.jks` and `src-tauri/gen/android/keystore.properties` safe** (copy them somewhere). Every update must be signed with the same key; with a different key Android makes you uninstall Aurora first, which deletes its data on the phone. (Builds without signing come out as `…-unsigned.apk`, which Android refuses to install: "the package appears to be invalid".)

**Android Auto with an app that isn't from the Play Store:** open the Android Auto settings on the phone, tap *Version* ten times to unlock developer settings, then in the ⋮ menu → *Developer settings* turn on **Unknown sources**. Aurora then shows up in the car's app list (you may need to add it under *Customize launcher*).

Note: this phone version was written without an Android device or the Android SDK at hand, so the first build may stop on a small compile error in the Kotlin part (`src-tauri/aurora-mobile/android`). The Rust and web parts are checked on every build (`cargo check --features simulate-android` type-checks the Android code paths on a PC).

## Publish on GitHub (so others can install it)

The repository has a workflow (`.github/workflows/release.yml`) that builds the Windows installer and the Android app on GitHub's computers and puts both on a **Release** page. Testers download from there; nobody needs Node, Rust or Android Studio.

### 1. Put the code on GitHub (once)

1. Make a free account on https://github.com and click **New repository**. Name it (e.g. `aurora`), choose *Public* (or *Private* and invite testers), and don't add a README (this folder has one).
2. Install Git (https://git-scm.com), open a terminal in this folder and run, with your user name and repository name:

```
git init
git add .
git commit -m "Aurora 0.2.0"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/aurora.git
git push -u origin main
```

`.gitignore` keeps your secrets out of the repository: `lastfm-key.json`, the Android signing key (`*.jks`, `keystore.properties`), `node_modules` and build output. Check with `git status` before the first commit that none of them is listed.

### 2. Add the secrets (once)

In the repository: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | What to paste |
| --- | --- |
| `ANDROID_KEYSTORE` | Your signing key as text. In PowerShell in this folder: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("src-tauri\aurora-release.jks")) \| Set-Clipboard`, then paste. |
| `ANDROID_KEY_PASSWORD` | The text after `password=` in `src-tauri\gen\android\keystore.properties`. |
| `LASTFM_KEY_JSON` (optional) | The contents of `src-tauri\lastfm-key.json`, so the builds have Last.fm built in. Without it, testers paste their own Last.fm key in the app. |

Use the same key you build with at home: then the phone app from GitHub and your own builds can update each other without uninstalling. Note that a key built into a public app can be dug out of it by someone determined; for a Last.fm key that's usually fine (you can make a new one at any time), but don't reuse it for anything else.

### 3. Make a release (every version)

1. Raise the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (e.g. `0.2.1`; Android only installs an update if the number went up).
2. Commit, then tag and push:

```
git commit -am "Aurora 0.2.1"
git tag v0.2.1
git push origin main v0.2.1
```

3. Watch it under the repository's **Actions** tab (about 15–25 minutes; the first run is the slowest). When both jobs are green, **Releases** has `Aurora-v0.2.1-windows-setup.exe` and `Aurora-v0.2.1-android.apk`. Releases are marked *pre-release* (testing); untick that on the release page when you're happy.

You can also start a build without a tag: **Actions → Release → Run workflow**, and type a tag name.

### What testers do

- **Windows**: download the `.exe` and run it. Windows SmartScreen may say "Windows protected your PC" because the installer isn't signed with a paid certificate: click **More info → Run anyway**. Aurora downloads yt-dlp and FFmpeg itself on first use.
- **Android** (Android 7+, 64-bit phones, which is nearly all of them): open the `.apk` on the phone (allow "install unknown apps" for the browser or Files app when asked). Play Protect may warn about an unknown app: **More details → Install anyway**. For Android Auto, see the note under "Build the Android app".
- Share the Release page link (`https://github.com/YOUR-NAME/aurora/releases`), which always lists the newest version first.

## Download tools

The first time you search, Aurora offers to install what it needs (about 150 MB, one time) into its own folder:

- **yt-dlp**: searches and downloads from YouTube.
- **FFmpeg**: converts to MP3 and embeds covers.
- **Deno**: yt-dlp needs a JavaScript runtime for YouTube. If Node.js is already installed, Aurora uses that and skips Deno.

If something is already on your PATH, Aurora uses it. When searches or downloads start failing, go to **Settings → Update yt-dlp**. YouTube changes often, and a fresh yt-dlp fixes most problems.

A note on use: YouTube's terms don't allow downloading except where YouTube offers it, so use this for music you have the rights to keep (your own uploads, Creative Commons, royalty-free and so on).

## Setting up Last.fm

**Easiest (for everyone using your build):** put your key in `src-tauri/lastfm-key.json` before building:

```json
{ "apiKey": "your 32-character key", "secret": "your shared secret" }
```

The key is then built into the app, and Profile → Last.fm shows only **Connect Last.fm**: users just sign in through the browser. (The file is in `.gitignore`; Last.fm desktop apps all work this way.)

**Or per install:**

1. Create a free API account at https://www.last.fm/api/account/create (application name: Aurora; callback URL: `http://127.0.0.1:43822/lastfm`).
2. Paste the API key and shared secret in Profile → Connections → Last.fm, then press **Connect Last.fm** and approve in the browser. Your Last.fm picture and name become the profile's picture and name (button to redo it any time).
3. One key serves every profile; each profile connects its own Last.fm account.

## Where things are stored

`%APPDATA%\app.aurora.player\` holds `profiles.json`, one `p-<profile>-settings/playlists/stats/recent.json` set per profile, `downloaded.json`, `library.json` (the scan cache), `covers\`, `playlist-covers\`, `avatars\`, `wallpapers\` and `bin\` (the download tools). Delete the folder to reset Aurora. Your music files are never touched. A backup contains everything except `library.json` and `bin\`, which are rebuilt.

## Project layout

```
src/                         Svelte UI
  App.svelte                 window shell, routing, shortcuts
  lib/player.svelte.ts       queue + transport (on Android it drives the native player)
  lib/output.svelte.ts       audio output device choice (Windows: setSinkId, Android: native)
  lib/downloads.svelte.ts    download queue (2 parallel), progress, auto-import
  lib/playlists.svelte.ts    playlists (stored as JSON)
  lib/tools.svelte.ts        yt-dlp / FFmpeg / JS runtime status + install
  lib/components/            title bar, sidebar, now-playing bar, virtual track list, context menu…
  lib/views/                 Home, Search, Library, Album, Playlist, Downloads, Settings
src-tauri/src/
  yt.rs                      yt-dlp song + album search, MP3 download, album tagging (lofty), cancel
  backup.rs                  zip backup / restore with id + path remapping (has tests)
  catalog.rs                 Deezer / iTunes catalog search (has tests)
  images.rs                  playlist covers, profile pictures, theme images
  lastfm.rs                  Last.fm calls, request signing, browser sign-in (has tests)
  tools.rs                   find or install yt-dlp, FFmpeg, Deno
  library.rs                 parallel folder scan, tags (lofty), cover thumbnails + colours
  storage.rs                 verified cover-art slimming (has tests)
  mp4fix.rs                  M4A repair: rebuilds fragmented files, fixes audio offsets broken by tagging
  store.rs                   JSON settings storage
  yt_android.rs              phone versions of the download commands
src-tauri/aurora-mobile/     the Android side (a Tauri plugin)
  src/lib.rs                 Rust API the app calls on Android
  android/…/PlaybackService  Media3 player service: background play, notification, Android Auto browse tree
  android/…/Library.kt       reads Aurora's library/playlists files for Android Auto
  android/…/Extractor.kt     YouTube/SoundCloud search and download (NewPipe Extractor)
  android/…/Outputs.kt       audio output devices
  android/…/PlayLog.kt       listening done while the app is closed, for stats and Last.fm
scripts/android-setup.mjs    adds JitPack + desugaring + the app icon to the generated Android project
scripts/android-icons.py     builds the Android launcher icons from src-tauri/icons/icon.png
.github/workflows/release.yml builds both apps on GitHub and publishes them as a Release
```

## Ideas for next steps

- Export playlists as `.m3u8` for other players and phones.
- Gapless playback / crossfade.
