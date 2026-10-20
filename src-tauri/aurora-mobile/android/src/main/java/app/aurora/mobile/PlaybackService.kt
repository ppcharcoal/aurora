package app.aurora.mobile

import android.app.PendingIntent
import android.content.Intent
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.audio.TeeAudioProcessor
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionError
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Aurora's player on Android. It keeps playing with the screen off and shows
 * the usual media notification / lock-screen controls. Bluetooth buttons,
 * Android Auto and the app itself are all "controllers" of this one player,
 * so they always agree on what's playing.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaLibraryService() {
  lateinit var player: ExoPlayer
    private set
  private var session: MediaLibrarySession? = null

  companion object {
    /** The running service (same process as the app), if any. */
    @Volatile
    var current: PlaybackService? = null
      private set

    /** "Smooth" transitions: fade length in ms (0 = None). Set by the app, remembered for Android Auto. */
    @Volatile
    var fadeMs = 0L
      private set

    fun setTransition(context: android.content.Context, ms: Long) {
      fadeMs = ms.coerceIn(0L, 12_000L)
      context.getSharedPreferences("aurora", android.content.Context.MODE_PRIVATE).edit().putLong("fadeMs", fadeMs).apply()
      current?.applyFade()
    }
  }

  /* ---- Smooth transitions: the end of a song fades out, the next fades in. ----
     The music files are untouched; only the player's volume moves. */

  /** The volume chosen in the app (0–1); fades work on top of it. */
  var userVolume = 1f
    set(v) {
      field = v.coerceIn(0f, 1f)
      applyFade()
    }
  private var fadingIn = false
  private val fader = android.os.Handler(android.os.Looper.getMainLooper())
  private val fadeTick = object : Runnable {
    override fun run() {
      applyFade()
      if (player.isPlaying && fadeMs > 0) fader.postDelayed(this, 80)
    }
  }

  fun applyFade() {
    if (!::player.isInitialized) return
    val ms = fadeMs
    if (ms <= 0 || player.repeatMode == Player.REPEAT_MODE_ONE) {
      fadingIn = false
      player.volume = userVolume
      return
    }
    val pos = player.currentPosition
    val dur = player.duration
    var f = 1f
    if (dur != C.TIME_UNSET && dur > ms * 2 && player.hasNextMediaItem()) {
      f = minOf(f, ((dur - pos).toFloat() / ms).coerceIn(0f, 1f))
    }
    val inMs = ms / 2
    if (fadingIn) {
      if (pos >= inMs) fadingIn = false else f = minOf(f, (pos.toFloat() / inMs).coerceIn(0f, 1f))
    }
    // Equal-power curve: sounds even, no dip in the middle.
    player.volume = userVolume * kotlin.math.sin(f * Math.PI.toFloat() / 2f)
  }

  override fun onCreate() {
    super.onCreate()
    // A copy of the audio goes to the visualizer (Spectrum), which ignores it unless it's open.
    val renderers = object : DefaultRenderersFactory(this) {
      override fun buildAudioSink(context: android.content.Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink =
        DefaultAudioSink.Builder(context)
          .setEnableFloatOutput(enableFloatOutput)
          .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
          .setAudioProcessors(arrayOf(TeeAudioProcessor(Spectrum)))
          .build()
    }
    player = ExoPlayer.Builder(this, renderers)
      .setAudioAttributes(
        AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
        /* handleAudioFocus = */ true,
      )
      .setHandleAudioBecomingNoisy(true) // pause when headphones are unplugged
      .setWakeMode(C.WAKE_MODE_LOCAL)
      .build()
    fadeMs = getSharedPreferences("aurora", MODE_PRIVATE).getLong("fadeMs", 0L)
    Outputs.apply(this, player)
    PlayLog.attach(this, player)
    player.addListener(object : Player.Listener {
      private var errors = 0

      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        // Only songs that follow on by themselves fade in (not a tap on another song).
        fadingIn = reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && fadeMs > 0
        applyFade()
        saveQueue()
      }
      override fun onTimelineChanged(timeline: Timeline, reason: Int) = saveQueue()

      override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) errors = 0
        fader.removeCallbacks(fadeTick)
        if (isPlaying && fadeMs > 0) fader.post(fadeTick)
      }

      // A missing or broken file: skip it (a few times at most), like the desktop app.
      override fun onPlayerError(error: PlaybackException) {
        if (++errors < 5 && player.hasNextMediaItem()) {
          player.seekToNextMediaItem()
          player.prepare()
          player.play()
        }
      }
    })

    val open = packageManager.getLaunchIntentForPackage(packageName)
    val builder = MediaLibrarySession.Builder(this, player, Callback())
    if (open != null) {
      builder.setSessionActivity(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    }
    session = builder.build()
    current = this
  }

  /** The app changed songs or playlists: refresh what Android Auto shows. */
  fun libraryChanged() {
    Library.invalidate()
    val s = session ?: return
    for (id in listOf(Library.ROOT, Library.RECENT, Library.PLAYLISTS, Library.ALBUMS, Library.SONGS)) {
      s.notifyChildrenChanged(id, Library.children(this, id).size, null)
    }
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Swiping the app away keeps the music going; with nothing playing, stop.
    if (!player.playWhenReady || player.mediaItemCount == 0) {
      PlayLog.finish()
      stopSelf()
    }
  }

  override fun onDestroy() {
    PlayLog.finish()
    saveQueue()
    current = null
    session?.release()
    session = null
    player.release()
    super.onDestroy()
  }

  /* ------------- remember the queue for "resume" (Bluetooth play button, car) ------------- */

  private fun queueFile() = File(dataDir, "native-queue.json")

  private fun saveQueue() {
    try {
      val ids = JSONArray()
      for (i in 0 until player.mediaItemCount) ids.put(player.getMediaItemAt(i).mediaId)
      val o = JSONObject().put("ids", ids).put("index", player.currentMediaItemIndex).put("positionMs", player.currentPosition)
      queueFile().writeText(o.toString())
    } catch (e: Exception) {
    }
  }

  private fun lastQueue(): MediaSession.MediaItemsWithStartPosition? = try {
    val o = JSONObject(queueFile().readText())
    val ids = o.getJSONArray("ids")
    val items = (0 until ids.length()).mapNotNull { Library.item(this, ids.getString(it)) }
    if (items.isEmpty()) null
    else MediaSession.MediaItemsWithStartPosition(items, o.optInt("index", 0).coerceIn(0, items.size - 1), o.optLong("positionMs", 0))
  } catch (e: Exception) {
    null
  }

  /* ------------------------- what Android Auto sees ------------------------- */

  private inner class Callback : MediaLibrarySession.Callback {
    private val ctx get() = this@PlaybackService

    override fun onGetLibraryRoot(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<MediaItem>> = Futures.immediateFuture(LibraryResult.ofItem(Library.root(ctx), params))

    override fun onGetChildren(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      parentId: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
      val all = Library.children(ctx, parentId)
      val from = (page.toLong() * pageSize).coerceAtMost(all.size.toLong()).toInt()
      val to = (from + pageSize).coerceAtMost(all.size)
      return Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.copyOf(all.subList(from, to)), params))
    }

    override fun onGetItem(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      mediaId: String,
    ): ListenableFuture<LibraryResult<MediaItem>> {
      val item = Library.item(ctx, mediaId)
      return Futures.immediateFuture(if (item != null) LibraryResult.ofItem(item, null) else LibraryResult.ofError<MediaItem>(SessionError.ERROR_BAD_VALUE))
    }

    override fun onSearch(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<Void>> {
      session.notifySearchResultChanged(browser, query, Library.search(ctx, query).size, params)
      return Futures.immediateFuture(LibraryResult.ofVoid())
    }

    override fun onGetSearchResult(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
      val all = Library.search(ctx, query)
      val from = (page * pageSize).coerceAtMost(all.size)
      return Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.copyOf(all.subList(from, (from + pageSize).coerceAtMost(all.size))), params))
    }

    /** Items from controllers carry only ids; fill in the files. */
    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> =
      Futures.immediateFuture(mediaItems.mapNotNull { Library.resolve(ctx, it) }.toMutableList())

    /**
     * Playing one song from a list (Android Auto) plays that whole list from
     * that song; "Shuffle all" shuffles the library; a voice search plays the matches.
     */
    override fun onSetMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
      startIndex: Int,
      startPositionMs: Long,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      if (mediaItems.size == 1) {
        val only = mediaItems[0]
        val query = only.requestMetadata.searchQuery
        if (only.mediaId.isEmpty() && !query.isNullOrBlank()) {
          val found = Library.search(ctx, query)
          if (found.isNotEmpty()) return Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(found, 0, C.TIME_UNSET))
        }
        if (only.mediaId == Library.SHUFFLE) {
          val all = Library.tracksOf(ctx, Library.SHUFFLE).shuffled().map { Library.song(it, Library.SONGS) }
          if (all.isNotEmpty()) return Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(all, 0, C.TIME_UNSET))
        }
        val (parent, id) = Library.split(only.mediaId)
        if (parent != null && only.localConfiguration == null) {
          val list = Library.tracksOf(ctx, parent)
          val at = list.indexOfFirst { it.id == id }
          if (at >= 0) {
            return Futures.immediateFuture(
              MediaSession.MediaItemsWithStartPosition(list.map { Library.song(it, parent) }, at, startPositionMs),
            )
          }
        }
      }
      val resolved = mediaItems.mapNotNull { Library.resolve(ctx, it) }
      return Futures.immediateFuture(
        MediaSession.MediaItemsWithStartPosition(resolved, startIndex.coerceIn(0, maxOf(0, resolved.size - 1)), startPositionMs),
      )
    }

    /** "Play" on headphones or in the car with nothing loaded: continue where you left off. */
    override fun onPlaybackResumption(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      isForPlayback: Boolean,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      val last = lastQueue() ?: return Futures.immediateFailedFuture(UnsupportedOperationException("Nothing to resume"))
      return Futures.immediateFuture(last)
    }
  }
}
