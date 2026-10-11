/** True in the Android app (Aurora's phone version). */
export const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
