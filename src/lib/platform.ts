/** True in the Android app (Aurora's phone version). */
export const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

/** True in the Linux desktop app (WebKitGTK). */
export const isLinux = !isAndroid && typeof navigator !== "undefined" && /Linux/i.test(navigator.userAgent);

/** True in the Electron build (Aurora's Linux app since 0.4). */
export const isElectron = typeof navigator !== "undefined" && /Electron/i.test(navigator.userAgent);

/** Linux with WebKitGTK: the system's sound settings choose the output device. */
export const systemPicksOutput = isLinux && !isElectron;

/** True in the Windows desktop app. */
export const isWindows = !isAndroid && !isLinux;

/** Folder separator for paths shown to the user. */
export const sep = isWindows ? "\\" : "/";

/** Where downloads go when no folder has been chosen yet, as shown to the user. */
export const defaultFolderLabel = isAndroid ? "Download/Aurora" : isLinux ? "~/Music/Aurora" : "Music\\Aurora";

/** The "follow the system" theme choice. */
export const systemThemeLabel = isAndroid ? "Match phone" : isLinux ? "Match system" : "Match Windows";
