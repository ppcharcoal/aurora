// Bundles the helper into dist/aurora-discord.cjs, plus the one native part
// (DAVE voice encryption, @snazzah/davey) for this computer's platform.
// The Windows build makes the Windows copy, the Linux build the Linux one.
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, "src", "main.js")],
  outfile: join(dist, "aurora-discord.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
  // Native or optional add-ons; the helper works without the optional ones.
  // `@snazzah/davey` → ./davey (copied below).
  plugins: [
    {
      name: "davey",
      setup(b) {
        b.onResolve({ filter: /^@snazzah\/davey$/ }, () => ({ path: "./davey/index.js", external: true }));
      },
    },
  ],
  external: [
    "zlib-sync", "bufferutil", "utf-8-validate", "erlpack",
    "@discordjs/opus", "opusscript", "node-opus",
    "sodium-native", "sodium", "libsodium-wrappers", "tweetnacl",
    "ffmpeg-static", "@noble/ciphers",
  ],
});

// The DAVE module goes in dist/davey/ with its native file next to it (it
// loads ./davey.<platform>.node first). No node_modules folder: installers
// (electron-builder) leave those out.
const src = join(root, "node_modules", "@snazzah");
const dst = join(dist, "davey");
cpSync(join(src, "davey"), dst, { recursive: true });
let natives = 0;
for (const name of readdirSync(src).filter((n) => n.startsWith("davey-"))) {
  for (const f of readdirSync(join(src, name)).filter((f) => f.endsWith(".node"))) {
    cpSync(join(src, name, f), join(dst, f));
    natives++;
  }
}
if (!natives) {
  console.error("No DAVE binary for this platform was installed (npm ci in discord/).");
  process.exit(1);
}
console.log("built", join(dist, "aurora-discord.cjs"), readdirSync(dst).filter((f) => f.endsWith(".node")).join(", "));
