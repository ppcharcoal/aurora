import type { RGB, Track } from "./types";

const cache = new Map<string, Promise<RGB | null>>();

/** Picks a vivid, readable colour from an image (sampled on a tiny canvas). */
function sample(url: string): Promise<RGB | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 12;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, 12, 12);
        const d = ctx.getImageData(0, 0, 12, 12).data;
        let r = 0, g = 0, b = 0, w = 0;
        for (let i = 0; i < d.length; i += 4) {
          const [pr, pg, pb] = [d[i], d[i + 1], d[i + 2]];
          const max = Math.max(pr, pg, pb);
          const min = Math.min(pr, pg, pb);
          const sat = max ? (max - min) / max : 0;
          const lum = (0.2126 * pr + 0.7152 * pg + 0.0722 * pb) / 255;
          const k = 0.05 + sat * sat * (1 - Math.abs(lum - 0.55));
          r += pr * k; g += pg * k; b += pb * k; w += k;
        }
        resolve([r / w, g / w, b / w].map(Math.round) as RGB);
      } catch {
        resolve(null); // tainted canvas (no CORS) → keep default accent
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

const lum = (c: number[]) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

/** Keeps an accent readable: bright enough on dark, deep enough on light. */
export function fitAccent(c: number[], mode: "dark" | "light"): RGB {
  const l = lum(c);
  let k = 1;
  if (mode === "dark" && l < 0.45) k = 0.45 / Math.max(l, 0.05);
  if (mode === "light" && l > 0.36) k = 0.36 / l;
  let out = c.map((v) => Math.min(255, v * k));
  // Brightening a near-grey colour can't reach the target; mix towards white.
  if (mode === "dark" && lum(out) < 0.4) out = out.map((v) => v + (255 - v) * 0.35);
  return out.map(Math.round) as RGB;
}

export function trackColor(t: Track | null): Promise<RGB | null> {
  if (!t) return Promise.resolve(null);
  if (t.color) return Promise.resolve(t.color);
  const url = t.art;
  if (!url) return Promise.resolve(null);
  let p = cache.get(url);
  if (!p) cache.set(url, (p = sample(url)));
  return p;
}
