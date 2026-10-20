<script lang="ts" module>
  // 24×24 stroke icons (single path data each).
  const P = {
    play: "M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z",
    pause: "M7 4h3.5v16H7zM13.5 4H17v16h-3.5z",
    next: "M5 5l10 7-10 7V5ZM19 5v14",
    prev: "M19 19 9 12l10-7v14ZM5 19V5",
    shuffle: "M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5",
    repeat: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3",
    volume: "M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14",
    volumeLow: "M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7",
    mute: "M11 5 6 9H2v6h4l5 4V5ZM22 9l-6 6M16 9l6 6",
    queue: "M3 6h13M3 12h13M3 18h8M18 15v6l4-3-4-3Z",
    undo: "M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-4",
    redo: "M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h4",
    bot: "M12 3v3M8 21h8M5 8h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM9 13h.01M15 13h.01M1 12v3M23 12v3",
    home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z",
    search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4-4",
    settings:
      "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
    plus: "M12 5v14M5 12h14",
    folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-12Z",
    heart: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z",
    x: "M6 6l12 12M18 6 6 18",
    min: "M5 12h14",
    max: "M5 5h14v14H5z",
    restore: "M8 8h11v11H8zM5 16V5h11",
    back: "M15 18l-6-6 6-6",
    device: "M4 5h16v10H4zM8 19h8M12 15v4",
    speaker: "M6 2h12a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1ZM12 18a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 6.5h.01",
    bluetooth: "M7 7l10 10-5 5V2l5 5L7 17",
    usb: "M12 3v15M9 6l3-3 3 3M12 13l-4-2V8M12 15l4-2v-3M12 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
    car: "M5 17h14M5 17a2 2 0 1 0 4 0M15 17a2 2 0 1 0 4 0M3 17v-4l2-5a2 2 0 0 1 1.9-1.4h10.2A2 2 0 0 1 19 8l2 5v4M3 13h18",
    output: "M4 6h16v10H4zM2 20h20M12 9.5a1.5 1.5 0 1 0 0 3",
    note: "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
    refresh: "M21 12a9 9 0 0 1-15.5 6.3M3 12A9 9 0 0 1 18.5 5.7M21 3v6h-6M3 21v-6h6",
    trash: "M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3",
    copy: "M9 9h11v11H9zM5 15H4V4h11v1",
    expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
    collapse: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
    disc: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
    download: "M12 3v12M7 10l5 5 5-5M5 21h14",
    check: "M5 12.5l4.5 4.5L19 7",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    playlistAdd: "M3 6h12M3 12h12M3 18h7M17 14v8M13 18h8",
    edit: "M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4",
    grip: "M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01",
    reveal: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1M3 7v11a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4L21.8 12a1.5 1.5 0 0 0-1.4-2H8.6a2 2 0 0 0-1.9 1.4L4 19",
    chevron: "M9 6l6 6-6 6",
    headphones: "M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3v5ZM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3v5Z",
    users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
    soundcloud: "M2 15.5v-3M5 17v-6M8 17V9M11 17V7.5c4-1.5 7.5.8 8 4.5a3 3 0 0 1 0 5H11",
    radio: "M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
    heartFill:
      "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z",
    sparkle: "M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z",
    link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
    youtube:
      "M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8ZM10 15V9l5.2 3L10 15Z",
  } as const;
  export type IconName = keyof typeof P;
  const FILLED = new Set<IconName>(["play", "pause", "youtube", "heartFill"]);
  export const ICONS = P;
  export const FILLED_ICONS = FILLED;
</script>

<script lang="ts">
  let { name, size = 18, stroke = 1.8 }: { name: IconName; size?: number; stroke?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  aria-hidden="true"
  fill={FILLED_ICONS.has(name) ? "currentColor" : "none"}
  stroke={FILLED_ICONS.has(name) ? "none" : "currentColor"}
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d={ICONS[name]} />
</svg>

<style>
  svg {
    flex: none;
    display: block;
  }
</style>
