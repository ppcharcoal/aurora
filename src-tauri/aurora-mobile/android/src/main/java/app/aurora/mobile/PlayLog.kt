package app.aurora.mobile

import android.content.Context
import android.os.SystemClock
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * What was actually listened to, kept by the playback service so listening
 * time, play counts and Last.fm scrobbles also count when the app's screen
 * isn't running (phone locked, in the car). The app collects the finished
 * entries ("plays") and adds them to the profile's stats.
 */
object PlayLog {
  private var file: File? = null
  private var id: String? = null
  private var startedAt = 0L
  private var listened = 0L
  private var durationMs = 0L
  private var playingSince = -1L

  fun attach(context: Context, player: Player) {
    file = File(context.dataDir, "native-plays.json")
    player.addListener(object : Player.Listener {
      override fun onIsPlayingChanged(isPlaying: Boolean) {
        synchronized(this@PlayLog) {
          val now = SystemClock.elapsedRealtime()
          if (isPlaying) {
            if (id == null) begin(player.currentMediaItem)
            playingSince = now
          } else if (playingSince >= 0) {
            listened += now - playingSince
            playingSince = -1
          }
        }
      }

      override fun onPlaybackStateChanged(state: Int) {
        if (state == Player.STATE_READY && player.duration > 0) synchronized(this@PlayLog) { durationMs = player.duration }
        if (state == Player.STATE_ENDED) finish()
      }

      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        finish()
        synchronized(this@PlayLog) {
          begin(mediaItem)
          if (player.isPlaying) playingSince = SystemClock.elapsedRealtime()
        }
      }
    })
  }

  private fun begin(item: MediaItem?) {
    id = item?.mediaId?.let { Library.trackId(it) }
    startedAt = System.currentTimeMillis() / 1000
    listened = 0
    durationMs = 0
    playingSince = -1
  }

  /** Closes the current play and saves it. */
  @Synchronized
  fun finish() {
    val now = SystemClock.elapsedRealtime()
    if (playingSince >= 0) {
      listened += now - playingSince
      playingSince = now
    }
    val track = id ?: return
    if (listened >= 1000) {
      val entries = load()
      entries.put(JSONObject().apply {
        put("id", track)
        put("startedAt", startedAt)
        put("listenedMs", listened)
        put("durationMs", durationMs)
      })
      save(entries)
    }
    id = null
    listened = 0
  }

  private fun load(): JSONArray = try {
    file?.takeIf { it.isFile }?.readText()?.let { JSONArray(it) } ?: JSONArray()
  } catch (e: Exception) {
    JSONArray()
  }

  private fun save(entries: JSONArray) {
    val f = file ?: return
    // Keep it bounded if the app isn't opened for a long time.
    val trimmed = if (entries.length() > 5000) JSONArray((entries.length() - 5000 until entries.length()).map { entries.get(it) }) else entries
    val tmp = File(f.parentFile, f.name + ".tmp")
    tmp.writeText(trimmed.toString())
    tmp.renameTo(f)
  }

  /** Hands the finished plays to the app and forgets them. */
  @Synchronized
  fun take(context: Context): JSArray {
    if (file == null) file = File(context.dataDir, "native-plays.json")
    val entries = load()
    file?.delete()
    val out = JSArray()
    for (i in 0 until entries.length()) {
      val e = entries.optJSONObject(i) ?: continue
      out.put(JSObject.fromJSONObject(e))
    }
    return out
  }
}
