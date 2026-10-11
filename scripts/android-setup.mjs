// Run after `tauri android init` (npm run android:init does both).
// Adds what Aurora's Android side needs to the generated Gradle project:
//  - the JitPack repository (NewPipe Extractor is published there)
//  - Java library desugaring (NewPipe Extractor uses newer Java APIs than
//    Android 7–12 ship with)
// Safe to run more than once.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.AURORA_ANDROID_DIR ?? join(import.meta.dirname, "..", "src-tauri", "gen", "android");
if (!existsSync(root)) {
  console.error("src-tauri/gen/android doesn't exist yet. Run `npm run android:init` first.");
  process.exit(1);
}

function patch(file, edits) {
  const path = join(root, file);
  let text = readFileSync(path, "utf8");
  let changed = false;
  for (const [marker, find, replace] of edits) {
    if (text.includes(marker)) continue;
    if (!find.test(text)) {
      console.error(`Couldn't find where to add "${marker}" in ${file}. Please add it by hand (see docs/BUILDING.md → Build the Android app).`);
      process.exitCode = 1;
      continue;
    }
    text = text.replace(find, replace);
    changed = true;
  }
  if (changed) writeFileSync(path, text);
  console.log(`${changed ? "updated" : "already set up"}: ${file}`);
}

patch("build.gradle.kts", [
  ["jitpack.io", /allprojects\s*\{\s*repositories\s*\{/, (m) => `${m}\n        maven("https://jitpack.io")`],
]);

patch(join("app", "build.gradle.kts"), [
  ["isCoreLibraryDesugaringEnabled", /compileOptions\s*\{/, (m) => `${m}\n        isCoreLibraryDesugaringEnabled = true`],
  ["desugar_jdk_libs_nio", /dependencies\s*\{/, (m) => `${m}\n    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs_nio:2.1.5")`],
]);

// Launcher icon: the same icon as the PC version, laid out the way Android
// expects (full-bleed background + symbol inside the safe zone), so the
// phone's circle/squircle crop doesn't cut it off.
{
  const { cpSync } = await import("node:fs");
  const from = join(import.meta.dirname, "..", "src-tauri", "icons", "android");
  const res = join(root, "app", "src", "main", "res");
  if (existsSync(from) && existsSync(res)) {
    cpSync(from, res, { recursive: true });
    console.log("updated: app icon");
  }
}
