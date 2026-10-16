# Building and releasing Aurora

Everything a developer needs: building the Windows and Android apps, publishing releases, the Last.fm key, where data lives and how the code is laid out. If you only want to use Aurora, grab it from the [Releases page](https://github.com/ppcharcoal/aurora/releases/latest) instead.

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

## Build on Linux

Install the build tools and libraries once. Arch:

```sh
sudo pacman -S --needed base-devel nodejs npm rust webkit2gtk-4.1 gtk3 libsoup3 librsvg \
  gst-plugins-base gst-plugins-good gst-libav yt-dlp python-mutagen ffmpeg deno
```

Debian/Ubuntu: `sudo apt install build-essential curl libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev gstreamer1.0-plugins-good gstreamer1.0-libav ffmpeg` plus Rust from https://rustup.rs and Node.js 20+.

Then, in this folder:

```sh
npm install
npm run app:dev                              # run with hot reload
npx tauri build --bundles deb,appimage       # packages in src-tauri/target/release/bundle/
node scripts/arch-pkgbuild.mjs 0.3.0 src-tauri/target/release/bundle/deb/*.deb PKGBUILD   # Arch package recipe
```

Notes:
- Playback goes through WebKitGTK's GStreamer backend, so `gst-plugins-good` (MP3, FLAC…) and `gst-libav` (AAC/M4A) must be installed.
- The download tools come from the package manager (Aurora's automatic installer is Windows-only).
- Audio output devices can't be picked from inside WebKitGTK; the system's sound settings decide.
- On NVIDIA, `WEBKIT_DISABLE_DMABUF_RENDERER=1` is set automatically (see `linux_display_fixes` in `src-tauri/src/lib.rs`).

## Build the Android app

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

`cargo check --features simulate-android` type-checks the Android code paths of the Rust side on a PC.

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

3. Watch it under the repository's **Actions** tab (about 15–25 minutes; the first run is the slowest). When both jobs are green, **Releases** has `Aurora-v0.2.1-windows-setup.exe`, `Aurora-v0.2.1-linux-x86_64.AppImage`, `Aurora-v0.2.1-linux-amd64.deb`, `PKGBUILD` and `Aurora-v0.2.1-android.apk`. Each release becomes the "latest" one, which the download links in the README always point to.

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
