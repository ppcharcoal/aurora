package app.aurora.mobile

import android.content.Context
import android.net.Uri
import android.os.Bundle
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaConstants
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Aurora's library as Android Auto (and the lock screen) see it, read straight
 * from the files the app keeps in its data folder, so it works even when the
 * app's screen isn't open:
 *   library.json            every song (path, tags, cover thumbnail)
 *   profiles.json           the active profile
 *   p-<profile>-playlists.json, p-<profile>-recent.json
 *
 * Browse tree:  root → Recent | Playlists → playlist | Albums → album | Songs
 * A song's media id is "<parent>/<track id>", so playing it from a list plays
 * the rest of that list after it.
 */
@OptIn(UnstableApi::class)
object Library {
  const val ROOT = "root"
  const val RECENT = "recent"
  const val PLAYLISTS = "playlists"
  const val ALBUMS = "albums"
  const val SONGS = "songs"
  const val SHUFFLE = "shuffle"

  class Track(
    val id: String,
    val path: String,
    val title: String,
    val artist: String,
    val album: String?,
    val albumArtist: String?,
    val trackNo: Int,
    val discNo: Int,
    val cover: String?,
    val durationMs: Double = 0.0,
  )

  private class Album(val id: String, val name: String, val artist: String, val tracks: List<Track>)
  private class Playlist(val id: String, val name: String, val trackIds: List<String>)

  private var loaded = false
  private var tracks: List<Track> = emptyList()
  private var byId: Map<String, Track> = emptyMap()
  private var albums: List<Album> = emptyList()
  private var playlists: List<Playlist> = emptyList()
  private var recent: List<String> = emptyList()
  private var artAuthority = ""

  /** A song by its id (for transitions), if it's in the library. */
  @Synchronized
  fun track(context: Context, id: String): Track? {
    ensure(context)
    return byId[id]
  }

  /** Forget the cached copy (the app changed the library or playlists). */
  @Synchronized
  fun invalidate() {
    loaded = false
  }

  private fun read(file: File): String? = try {
    if (file.isFile) file.readText() else null
  } catch (e: Exception) {
    null
  }

  @Synchronized
  private fun ensure(context: Context) {
    if (loaded) return
    loaded = true
    artAuthority = "${context.packageName}.aurora.art"
    val dir = context.dataDir
    val list = ArrayList<Track>()
    read(File(dir, "library.json"))?.let { text ->
      val arr = JSONObject(text).optJSONArray("tracks") ?: JSONArray()
      for (i in 0 until arr.length()) {
        val t = arr.optJSONObject(i) ?: continue
        val tagged = t.optBoolean("albumTagged", false)
        list.add(
          Track(
            id = t.optString("id"),
            path = t.optString("path"),
            title = t.optString("title"),
            artist = t.optString("artist"),
            album = if (tagged) t.optString("album") else null,
            albumArtist = t.optString("albumArtist").takeIf { it.isNotEmpty() && it != "null" },
            trackNo = t.optInt("trackNo", 0),
            discNo = t.optInt("discNo", 0),
            cover = t.optString("cover").takeIf { it.isNotEmpty() && it != "null" },
            durationMs = t.optDouble("durationMs", 0.0),
          ),
        )
      }
    }
    tracks = list.sortedWith(compareBy({ it.artist.lowercase() }, { it.title.lowercase() }))
    byId = list.associateBy { it.id }
    albums = list.filter { it.album != null }
      .groupBy { "${(it.albumArtist ?: it.artist).lowercase()}\u0001${it.album!!.lowercase()}" }
      .map { (key, ts) ->
        val first = ts.first()
        Album("al:" + Integer.toHexString(key.hashCode()), first.album!!, first.albumArtist ?: first.artist, ts.sortedWith(compareBy({ it.discNo }, { it.trackNo })))
      }
      .sortedBy { it.name.lowercase() }

    val profile = read(File(dir, "profiles.json"))?.let { JSONObject(it).optString("active") }.orEmpty()
    playlists = emptyList()
    recent = emptyList()
    if (profile.isNotEmpty()) {
      read(File(dir, "p-$profile-playlists.json"))?.let { text ->
        val arr = JSONArray(text)
        playlists = (0 until arr.length()).mapNotNull { i ->
          val p = arr.optJSONObject(i) ?: return@mapNotNull null
          val ids = p.optJSONArray("trackIds") ?: JSONArray()
          Playlist(p.optString("id"), p.optString("name"), (0 until ids.length()).map { ids.optString(it) })
        }
      }
      read(File(dir, "p-$profile-recent.json"))?.let { text ->
        val arr = JSONArray(text)
        recent = (0 until arr.length()).map { arr.optString(it) }
      }
    }
  }

  private fun artUri(cover: String?): Uri? {
    val name = cover?.let { File(it).name } ?: return null
    return Uri.parse("content://$artAuthority/$name")
  }

  private fun folder(id: String, title: String, subtitle: String? = null, art: String? = null, grid: Boolean = false): MediaItem {
    val extras = Bundle()
    if (grid) {
      extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM)
      extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
    }
    val meta = MediaMetadata.Builder()
      .setTitle(title)
      .setSubtitle(subtitle)
      .setArtworkUri(artUri(art))
      .setIsBrowsable(true)
      .setIsPlayable(false)
      .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
      .setExtras(extras)
      .build()
    return MediaItem.Builder().setMediaId(id).setMediaMetadata(meta).build()
  }

  fun song(t: Track, parent: String?): MediaItem {
    val meta = MediaMetadata.Builder()
      .setTitle(t.title)
      .setArtist(t.artist)
      .setAlbumTitle(t.album)
      .setAlbumArtist(t.albumArtist)
      .setTrackNumber(if (t.trackNo > 0) t.trackNo else null)
      .setArtworkUri(artUri(t.cover))
      .setIsBrowsable(false)
      .setIsPlayable(true)
      .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
      .build()
    return MediaItem.Builder()
      .setMediaId(if (parent != null) "$parent/${t.id}" else t.id)
      .setUri(Uri.fromFile(File(t.path)))
      .setMediaMetadata(meta)
      .build()
  }

  fun root(context: Context): MediaItem {
    ensure(context)
    return folder(ROOT, "Aurora")
  }

  /** The songs a list contains (in play order). */
  @Synchronized
  fun tracksOf(context: Context, parent: String): List<Track> {
    ensure(context)
    return when {
      parent == RECENT -> recent.mapNotNull { byId[it] }
      parent == SONGS || parent == SHUFFLE -> tracks
      parent.startsWith("pl:") -> playlists.firstOrNull { "pl:${it.id}" == parent }?.trackIds?.mapNotNull { byId[it] } ?: emptyList()
      parent.startsWith("al:") -> albums.firstOrNull { it.id == parent }?.tracks ?: emptyList()
      else -> emptyList()
    }
  }

  @Synchronized
  fun children(context: Context, parent: String): List<MediaItem> {
    ensure(context)
    return when (parent) {
      ROOT -> listOf(
        folder(RECENT, "Recent"),
        folder(PLAYLISTS, "Playlists", grid = true),
        folder(ALBUMS, "Albums", grid = true),
        folder(SONGS, "Songs"),
      )
      PLAYLISTS -> playlists.map { p ->
        val first = p.trackIds.firstNotNullOfOrNull { byId[it]?.cover }
        folder("pl:${p.id}", p.name, "${p.trackIds.size} songs", first)
      }
      ALBUMS -> albums.map { a -> folder(a.id, a.name, a.artist, a.tracks.firstNotNullOfOrNull { it.cover }) }
      SONGS -> {
        val shuffle = MediaItem.Builder()
          .setMediaId(SHUFFLE)
          .setMediaMetadata(
            MediaMetadata.Builder().setTitle("Shuffle all").setSubtitle("${tracks.size} songs")
              .setIsBrowsable(false).setIsPlayable(true).setMediaType(MediaMetadata.MEDIA_TYPE_PLAYLIST).build(),
          )
          .build()
        listOf(shuffle) + tracks.map { song(it, SONGS) }
      }
      else -> tracksOf(context, parent).map { song(it, parent) }
    }
  }

  @Synchronized
  fun item(context: Context, mediaId: String): MediaItem? {
    ensure(context)
    if (mediaId == ROOT) return root(context)
    val (parent, id) = split(mediaId)
    byId[id]?.let { return song(it, parent) }
    return children(context, ROOT).firstOrNull { it.mediaId == mediaId }
      ?: children(context, PLAYLISTS).firstOrNull { it.mediaId == mediaId }
      ?: children(context, ALBUMS).firstOrNull { it.mediaId == mediaId }
  }

  /** "<parent>/<track id>" → (parent, track id); a bare id has no parent. */
  fun split(mediaId: String): Pair<String?, String> {
    val i = mediaId.lastIndexOf('/')
    return if (i < 0) null to mediaId else mediaId.substring(0, i) to mediaId.substring(i + 1)
  }

  @Synchronized
  fun search(context: Context, query: String): List<MediaItem> {
    ensure(context)
    val words = query.lowercase().split(' ').filter { it.isNotBlank() }
    if (words.isEmpty()) return emptyList()
    return tracks.filter { t ->
      val hay = "${t.title} ${t.artist} ${t.album.orEmpty()}".lowercase()
      words.all { hay.contains(it) }
    }.take(50).map { song(it, null) }
  }

  /**
   * Makes items playable: items from Android Auto or the app carry only an id,
   * so the file and tags are filled in from the library.
   */
  @Synchronized
  fun resolve(context: Context, item: MediaItem): MediaItem? {
    ensure(context)
    if (item.localConfiguration != null) return item
    val (parent, id) = split(item.mediaId)
    byId[id]?.let { return song(it, parent) }
    // Not in the library (yet): the app also sends the file path.
    val uri = item.requestMetadata.mediaUri ?: return null
    return item.buildUpon().setUri(uri).build()
  }

  fun trackId(mediaId: String) = split(mediaId).second
}
