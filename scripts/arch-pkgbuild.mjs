// Writes the Arch Linux PKGBUILD for a release.
// Usage: node scripts/arch-pkgbuild.mjs <version> <path to the .deb> <output file>
// e.g.   node scripts/arch-pkgbuild.mjs 0.3.0 out/Aurora-v0.3.0-linux-amd64.deb out/PKGBUILD
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [version, deb, out] = process.argv.slice(2);
if (!version || !deb || !out) {
  console.error("Usage: node scripts/arch-pkgbuild.mjs <version> <deb> <output>");
  process.exit(1);
}
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const root = join(import.meta.dirname, "..");
const text = readFileSync(join(root, "packaging", "arch", "PKGBUILD.in"), "utf8")
  .replaceAll("@VERSION@", version.replace(/^v/, ""))
  .replaceAll("@DEB_SHA256@", sha(deb))
  .replaceAll("@LICENSE_SHA256@", sha(join(root, "LICENSE")));
writeFileSync(out, text);
console.log(`written: ${out}`);
