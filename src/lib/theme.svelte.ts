import { invoke } from "@tauri-apps/api/core";
import { pickImage } from "./pick";
import { fitAccent, trackColor } from "./color";
import { imageSrc } from "./paths";
import { player } from "./player.svelte";
import { profiles } from "./profiles.svelte";
import { settings } from "./settings.svelte";
import type { RGB } from "./types";
import { ui } from "./ui.svelte";

const DEFAULT_ACCENT: RGB = [94, 224, 196];

/** Light/dark mode, background image and the live accent colour. */
class Theme {
  private systemDark = $state(true);
  private coverColor = $state<RGB | null>(null);

  mode = $derived<"dark" | "light">(
    settings.value.theme === "system" ? (this.systemDark ? "dark" : "light") : settings.value.theme,
  );
  wallpaperSrc = $derived(imageSrc("wallpaper", settings.value.wallpaper));
  /** The background actually shown (image mode without an image falls back to plain). */
  background = $derived(settings.value.background === "image" && !settings.value.wallpaper ? "plain" : settings.value.background);

  /** Call once from the root component. */
  init() {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    this.systemDark = mq.matches;
    mq.addEventListener("change", (e) => (this.systemDark = e.matches));

    $effect.root(() => {
      $effect(() => {
        document.documentElement.dataset.theme = this.mode;
      });
      // Cover colour of whatever is playing.
      $effect(() => {
        const t = player.current;
        trackColor(t).then((c) => {
          if (t === player.current) this.coverColor = c;
        });
      });
      // Accent priority: playing cover → theme image → default.
      $effect(() => {
        const base =
          this.coverColor ??
          (this.background === "image" ? settings.value.wallpaperColor : undefined) ??
          DEFAULT_ACCENT;
        const c = fitAccent(base, this.mode);
        document.documentElement.style.setProperty("--accent-rgb", c.join(" "));
      });
    });
  }

  /** Pick an image from the PC; Aurora keeps its own copy (it's included in backups). */
  async chooseWallpaper() {
    const file = await pickImage("Choose a theme image");
    if (!file) return;
    try {
      const name = await invoke<string>("image_store", { kind: "wallpaper", owner: profiles.activeId, source: file });
      const color = await invoke<RGB>("image_color", { kind: "wallpaper", name });
      settings.set("wallpaper", name);
      settings.set("wallpaperColor", color);
      settings.set("background", "image");
    } catch (e) {
      ui.error(e);
    }
  }

  removeWallpaper() {
    const name = settings.value.wallpaper;
    if (name) invoke("image_remove", { kind: "wallpaper", name }).catch(() => {});
    settings.set("wallpaper", undefined);
    settings.set("wallpaperColor", undefined);
    if (settings.value.background === "image") settings.set("background", "cover");
  }
}

export const theme = new Theme();
