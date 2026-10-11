import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { native } from "./native";
import { isAndroid } from "./platform";

/**
 * Lets the user pick an image and returns a path Aurora can read.
 * Windows: the file dialog. Android: the phone's picture picker; the picked
 * image is copied into Aurora's cache first (Android doesn't give out paths).
 */
export async function pickImage(title: string): Promise<string | null> {
  if (isAndroid) {
    const r = await native.call<{ path: string | null }>("pickImage");
    return r.path ?? null;
  }
  const file = await openDialog({
    title,
    multiple: false,
    directory: false,
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] }],
  });
  return typeof file === "string" ? file : null;
}
