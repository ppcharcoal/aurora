import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { lastfm } from "./lastfm.svelte";
import { player } from "./player.svelte";
import { playlists } from "./playlists.svelte";
import type { Track } from "./types";
import { ui, type MenuItem } from "./ui.svelte";

/** "Add to playlist" submenu for one or more songs. */
export function addToPlaylistItems(trackIds: string[], onPick?: (playlistId: string) => void): MenuItem[] {
  const pick = onPick ?? ((id: string) => playlists.add(id, trackIds));
  return [
    {
      label: "New playlist…",
      icon: "plus",
      action: async () => {
        const id = await playlists.createInteractive(onPick ? [] : trackIds);
        if (id && onPick) onPick(id);
      },
    },
    ...(playlists.list.length ? [{ label: "", divider: true }] : []),
    ...playlists.list.map((p) => ({ label: p.name, action: () => pick(p.id) })),
  ];
}

export function trackMenu(t: Track, ctx?: { playlistId?: string; index?: number }): MenuItem[] {
  const items: MenuItem[] = [
    { label: "Play next", icon: "next", action: () => player.playNext(t) },
    { label: "Add to queue", icon: "queue", action: () => player.addToQueue(t) },
    { label: "Add to playlist", icon: "playlistAdd", submenu: addToPlaylistItems([t.id]) },
    { label: lastfm.isLoved(t) ? "Unlove" : "Love", icon: "heart", action: () => lastfm.toggleLove(t) },
  ];
  if (lastfm.hasKey) {
    items.push({ label: "Start radio from this song", icon: "radio", action: () => lastfm.startRadio(t) });
  }
  if (ctx?.playlistId != null && ctx.index != null) {
    const { playlistId, index } = ctx;
    items.push({
      label: "Remove from this playlist",
      icon: "x",
      danger: true,
      action: () => playlists.removeTrack(playlistId, index),
    });
  }
  items.push(
    { label: "", divider: true },
    { label: "Show in folder", icon: "reveal", action: () => revealItemInDir(t.path).catch(ui.error) },
  );
  return items;
}
