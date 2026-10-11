// One-time setup so Android builds come out signed (Android refuses to install
// unsigned apps). Run with: npm run android:signing
//
// 1. Creates a signing key at src-tauri/aurora-release.jks (if there isn't one).
//    KEEP THIS FILE (and keystore.properties): app updates must be signed with
//    the same key, or the phone makes you uninstall Aurora first.
// 2. Writes src-tauri/gen/android/keystore.properties with its password.
// 3. Tells the Android project to sign release builds with it.
// Safe to run more than once.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tauri = join(import.meta.dirname, "..", "src-tauri");
const android = process.env.AURORA_ANDROID_DIR ?? join(tauri, "gen", "android");
if (!existsSync(android)) {
  console.error("src-tauri/gen/android doesn't exist yet. Run `npm run android:init` first.");
  process.exit(1);
}

const keystore = join(tauri, "aurora-release.jks");
const propsFile = join(android, "keystore.properties");

// ---- 1 + 2. key and password ----
let password;
if (existsSync(propsFile)) {
  password = /^password=(.*)$/m.exec(readFileSync(propsFile, "utf8"))?.[1]?.trim();
}
if (!existsSync(keystore)) {
  password = randomBytes(18).toString("base64url");
  const candidates = [
    process.env.JAVA_HOME && join(process.env.JAVA_HOME, "bin", "keytool"),
    "C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\keytool.exe",
    "keytool",
  ].filter(Boolean);
  let made = false;
  for (const keytool of candidates) {
    const r = spawnSync(
      keytool,
      [
        "-genkeypair", "-noprompt", "-v",
        "-keystore", keystore,
        "-alias", "aurora",
        "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
        "-storepass", password, "-keypass", password,
        "-dname", "CN=Aurora, O=Aurora",
      ],
      { stdio: "inherit" },
    );
    if (r.status === 0) {
      made = true;
      break;
    }
  }
  if (!made) {
    console.error("Couldn't run keytool. Set JAVA_HOME to Android Studio's jbr folder and try again.");
    process.exit(1);
  }
  console.log(`created: ${keystore}  <- back this file up`);
} else if (!password) {
  console.error(`${keystore} exists but ${propsFile} is missing its password. Restore keystore.properties, or delete the .jks to make a new key.`);
  process.exit(1);
}
writeFileSync(propsFile, `password=${password}\nkeyAlias=aurora\nstoreFile=${keystore.replace(/\\/g, "\\\\")}\n`);
console.log(`written: ${propsFile}`);

// ---- 3. sign release builds ----
const gradleFile = join(android, "app", "build.gradle.kts");
let gradle = readFileSync(gradleFile, "utf8");
if (!gradle.includes("signingConfigs.getByName(\"release\")")) {
  const config = `android {
    signingConfigs {
        create("release") {
            // Filled in by scripts/android-signing.mjs
            val signing = Properties().apply {
                val f = rootProject.file("keystore.properties")
                if (f.exists()) f.inputStream().use { load(it) }
            }
            keyAlias = signing.getProperty("keyAlias")
            keyPassword = signing.getProperty("password")
            storeFile = signing.getProperty("storeFile")?.let { file(it) }
            storePassword = signing.getProperty("password")
        }
    }`;
  if (!/^android\s*\{/m.test(gradle) || !/getByName\("release"\)\s*\{/.test(gradle)) {
    console.error("Couldn't find where to add signing in app/build.gradle.kts (see docs/BUILDING.md → Build the Android app).");
    process.exit(1);
  }
  gradle = gradle.replace(/^android\s*\{/m, config);
  gradle = gradle.replace(/getByName\("release"\)\s*\{/, (m) => `${m}\n            signingConfig = signingConfigs.getByName("release")`);
  writeFileSync(gradleFile, gradle);
  console.log(`updated: ${gradleFile}`);
} else {
  console.log("already set up: app/build.gradle.kts");
}
console.log("\nDone. Now run: npm run android:build");
