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

    /** The app changed transitions (or the default): plan the next one again. */
    fun setTransition(context: android.content.Context, ms: Long) {
      Transitions.changed()
      current?.let { svc -> svc.handler.post { svc.replanSafe() } }
    }

    /** Volume sync switched in the app's settings. */
    fun setNormalize(on: Boolean) {
      current?.let { svc -> svc.handler.post { svc.normOn = on } }
    }
  }

  /* ------------------------------------------------------------------------
   * Volume sync (Settings → Playback): every song at about the same loudness.
   * Songs are measured (Loudness.kt) as they come up, the next one ahead of
   * time, and the rest of the library slowly in the background. Each song's
   * level is a multiplier in FxProcessor, on top of the transition lines, so
   * transitions sound the same as before. Files are never changed.
   * --------------------------------------------------------------------- */

  var normOn = false
    set(v) {
      if (field == v) return
      field = v
      updateNorms()
      if (v) scanLibrary()
    }

  /** Song path → multiplier, for the songs measured so far. */
  private val normByPath = HashMap<String, Float>()
  private val normPending = HashSet<String>()
  private val normWorker = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "aurora-loudness").apply { priority = Thread.MIN_PRIORITY + 1 } }
  private val scanWorker = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "aurora-loudness-scan").apply { priority = Thread.MIN_PRIORITY } }
  private var scanning = false

  /** Gives both players the levels of the current and next songs (measuring them if needed). */
  fun updateNorms() {
    if (!::player.isInitialized) return
    if (!normOn) {
      fxMain.norms = emptyMap()
      fxSide.norms = emptyMap()
      return
    }
    val map = HashMap<String, Float>()
    val idx = player.currentMediaItemIndex
    if (idx == C.INDEX_UNSET) return
    val indices = listOf(idx, player.nextMediaItemIndex, player.previousMediaItemIndex, plan?.bIndex ?: C.INDEX_UNSET)
    for (i in indices) {
      if (i == C.INDEX_UNSET || i >= player.mediaItemCount) continue
      val item = player.getMediaItemAt(i)
      val path = pathOf(item) ?: continue
      val g = normByPath[path]
      if (g != null) {
        map[item.mediaId] = g
      } else if (normPending.add(path)) {
        normWorker.execute {
          val r = try {
            Loudness.of(this, path)
          } catch (e: Exception) {
            null
          }
          handler.post {
            normPending.remove(path)
            normByPath[path] = r?.let { Loudness.gain(it) } ?: 1f
            updateNorms()
          }
        }
      }
    }
    fxMain.norms = map
    fxSide.norms = map
  }

  /** The app couldn't tell the processor which song it is: go by what the player says. */
  private fun checkPlaying() {
    val id = player.currentMediaItem?.mediaId ?: return
    if (!fxMain.streamKnown) fxMain.playingId = id
    handler.postDelayed({
      // Still not matching after a while (no song change seen in the audio): fix it.
      if (phase == Phase.IDLE && player.currentMediaItem?.mediaId == id && fxMain.playingId != id) fxMain.playingId = id
    }, 2000)
  }

  /** Measures the rest of the library, slowly, so songs are ready before they play. */
  private fun scanLibrary() {
    if (scanning) return
    scanning = true
    val ctx = applicationContext
    scanWorker.execute {
      try {
        for (t in Library.tracksOf(ctx, Library.SONGS)) {
          if (!normOn) break
          try {
            Loudness.of(ctx, t.path)
          } catch (e: Exception) {
          }
        }
      } catch (e: Exception) {
      }
      handler.post { scanning = false }
    }
  }

  /** The setting saved in the app (for when the app isn't open, e.g. Android Auto). */
  private fun savedNormalize(): Boolean = try {
    val profile = JSONObject(File(dataDir, "profiles.json").readText()).optString("active")
    JSONObject(File(dataDir, "p-$profile-settings.json").readText()).optBoolean("volumeSync", false)
  } catch (e: Exception) {
    false
  }

  /* ------------------------------------------------------------------------
   * Transitions (see Mix.kt), like the desktop app: near the end of song A,
   * a second player plays song B over it, each with its own volume and
   * effect lines (FxProcessor). When A has stopped, the main player jumps
   * to B at the same spot and takes over, with a short crossfade, so the
   * notification, lock screen and Android Auto always show the main player.
   * Any surprise (a seek, a skip, an error) just cancels the transition.
   * The music files are only read, never changed.
   * --------------------------------------------------------------------- */

  /** The volume chosen in the app (0–1); transitions work on top of it. */
  var userVolume = 1f
    set(v) {
      field = v.coerceIn(0f, 1f)
      if (::player.isInitialized) player.volume = field
      side?.volume = field
    }

  val handler = android.os.Handler(android.os.Looper.getMainLooper())
  private val fxMain = FxProcessor()
  private val fxSide = FxProcessor()
  private var side: ExoPlayer? = null
  private var sideFor: String? = null

  private class Plan(val bIndex: Int, val bId: String, val mix: Mix)
  private enum class Phase { IDLE, READY, OVERLAP, HANDOVER, TAIL }

  private var plan: Plan? = null
  private var planKey = ""
  private var phase = Phase.IDLE
  /** After the take-over: the rest of B's lines. */
  private var tail: Mix? = null
  /** Our own jumps don't count as "the user moved". */
  private var ownSeekUntil = 0L
  private var handoverAt = 0L
  private var mainBackAt = 0L
  private var ticking = false
  private val tick = object : Runnable {
    override fun run() {
      try {
        step()
      } catch (e: Exception) {
        cancelMix()
      }
      if (needTick()) handler.postDelayed(this, 40) else ticking = false
    }
  }

  private fun needTick() = phase == Phase.HANDOVER || (player.playWhenReady && (plan != null || phase != Phase.IDLE || tail != null))

  private fun kick() {
    if (!ticking && needTick()) {
      ticking = true
      handler.post(tick)
    }
  }

  private fun now() = android.os.SystemClock.elapsedRealtime()

  private fun pathOf(item: MediaItem): String? =
    item.localConfiguration?.uri?.path ?: Library.track(this, Library.trackId(item.mediaId))?.path

  fun replanSafe() {
    try {
      replan()
    } catch (e: Exception) {
      plan = null
    }
    kick()
  }

  /** Works out the transition from the current song into the next one. */
  private fun replan() {
    if (phase == Phase.OVERLAP || phase == Phase.HANDOVER) return
    val idx = player.currentMediaItemIndex
    val next = player.nextMediaItemIndex
    if (player.repeatMode == Player.REPEAT_MODE_ONE || idx == C.INDEX_UNSET || next == C.INDEX_UNSET) return setPlan(null)
    val a = player.getMediaItemAt(idx)
    val b = player.getMediaItemAt(next)
    val aId = Library.trackId(a.mediaId)
    val bId = Library.trackId(b.mediaId)
    if (aId == bId) return setPlan(null)
    val aPath = pathOf(a) ?: return setPlan(null)
    val bPath = pathOf(b) ?: return setPlan(null)
    val aDur = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.toDouble() ?: (Library.track(this, aId)?.durationMs ?: 0.0)
    val bDur = Library.track(this, bId)?.durationMs ?: 0.0
    if (aDur <= 0 || bDur <= 0) return setPlan(null)
    val key = "$aId>$bId#$next#${Transitions.version}#${aDur.toLong()}"
    if (key == planKey) return
    planKey = key
    val mix = Transitions.plan(this, aId, aPath, aDur, bId, bPath, bDur) {
      handler.post {
        planKey = ""
        replanSafe()
      }
    }
    setPlan(mix?.let { Plan(next, bId, it) })
  }

  private fun setPlan(p: Plan?) {
    if (phase == Phase.READY && sideFor != p?.bId) stopSide()
    if (p == null) planKey = ""
    plan = p
    if (phase == Phase.READY && p == null) phase = Phase.IDLE
    if (p == null && tail == null) {
      fxMain.gain = 1f
      fxMain.fx = Fx.NONE
    }
    kick()
  }

  private fun ensureSide(): ExoPlayer {
    side?.let { return it }
    val renderers = object : DefaultRenderersFactory(this) {
      override fun buildAudioSink(context: android.content.Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink =
        DefaultAudioSink.Builder(context)
          .setEnableFloatOutput(enableFloatOutput)
          .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
          .setAudioProcessors(arrayOf(fxSide))
          .build()
    }
    val s = ExoPlayer.Builder(this, renderers)
      .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), false)
      .build()
    s.volume = userVolume
    Outputs.apply(this, s)
    side = s
    return s
  }

  private fun stopSide() {
    side?.let {
      it.stop()
      it.clearMediaItems()
    }
    sideFor = null
  }

  /** Something unexpected happened: no transition this time, the music just carries on. */
  private fun cancelMix() {
    try {
      stopSide()
    } catch (e: Exception) {
    }
    phase = Phase.IDLE
    tail = null
    fxMain.gain = 1f
    fxMain.fx = Fx.NONE
    planKey = ""
    handler.post { replanSafe() }
  }

  private fun prepareSide(p: Plan, atMs: Double) {
    val s = ensureSide()
    if (sideFor != p.bId) {
      val item = player.getMediaItemAt(p.bIndex)
      if (!fxSide.streamKnown) fxSide.playingId = item.mediaId
      s.setMediaItem(item)
      s.prepare()
      sideFor = p.bId
    }
    s.seekTo(atMs.toLong().coerceAtLeast(0))
  }

  private fun step() {
    val p = plan
    val t = player.currentPosition.toDouble()
    when (phase) {
      Phase.IDLE, Phase.READY, Phase.TAIL -> {
        var g = 1.0
        var fx = Fx.NONE
        tail?.let { m ->
          val bT = m.bStart + (t - m.bOffset)
          if (bT >= m.end()) {
            tail = null
            if (phase == Phase.TAIL) phase = Phase.IDLE
          } else {
            g = m.gainB(bT)
            fx = m.fxB(bT)
          }
        }
        if (p != null && player.currentMediaItemIndex != C.INDEX_UNSET) {
          g *= p.mix.gainA(t)
          if (p.mix.aFx.isNotEmpty()) fx = p.mix.fxA(t)
          if (phase != Phase.READY && t >= p.mix.bStart - 5000) {
            prepareSide(p, p.mix.bOffset)
            fxSide.gain = 0f
            tail = null
            phase = Phase.READY
          }
          if (t >= p.mix.bStart && player.isPlaying) {
            val late = t - p.mix.bStart
            prepareSide(p, p.mix.bOffset + late)
            fxSide.gain = p.mix.gainB(t).toFloat()
            fxSide.fx = p.mix.fxB(t)
            side?.play()
            phase = Phase.OVERLAP
          }
        }
        fxMain.gain = g.toFloat()
        fxMain.fx = fx
      }
      Phase.OVERLAP -> {
        val m = p?.mix ?: return cancelMix()
        val s = side ?: return cancelMix()
        if (!player.playWhenReady) {
          if (s.playWhenReady) s.pause()
          return
        }
        if (!s.playWhenReady) s.play()
        val bT = m.bStart + (s.currentPosition - m.bOffset)
        fxMain.gain = m.gainA(t).toFloat()
        fxMain.fx = if (m.aFx.isNotEmpty()) m.fxA(t) else Fx.NONE
        fxSide.gain = m.gainB(bT).toFloat()
        fxSide.fx = m.fxB(bT)
        val aDur = player.duration
        val aDone = t >= m.aEnd || player.playbackState == Player.STATE_ENDED || (aDur != C.TIME_UNSET && aDur - t < 80)
        if (aDone) beginHandover(p, s)
      }
      Phase.HANDOVER -> {
        val m = p?.mix ?: return cancelMix()
        val s = side ?: return cancelMix()
        val bT = m.bStart + (s.currentPosition - m.bOffset)
        fxSide.gain = m.gainB(bT).toFloat()
        fxSide.fx = m.fxB(bT)
        if (player.currentMediaItemIndex == p.bIndex && player.isPlaying) {
          if (mainBackAt == 0L) mainBackAt = now()
          // A short crossfade from the second player to the main one (same song, same spot).
          val k = ((now() - mainBackAt) / 150.0).coerceIn(0.0, 1.0)
          val mainT = m.bStart + (player.currentPosition - m.bOffset)
          fxMain.gain = (m.gainB(mainT) * k).toFloat()
          fxMain.fx = m.fxB(mainT)
          fxSide.gain = (m.gainB(bT) * (1 - k)).toFloat()
          if (k >= 1) {
            stopSide()
            tail = m
            plan = null
            planKey = ""
            phase = Phase.TAIL
            replanSafe()
          }
        } else if (now() - handoverAt > 5000) {
          // The main player didn't get there: let it play on its own.
          cancelMix()
        }
      }
    }
  }

  /** A has stopped: the main player jumps to B where the second player is, then takes over. */
  private fun beginHandover(p: Plan, s: ExoPlayer) {
    phase = Phase.HANDOVER
    handoverAt = now()
    mainBackAt = 0L
    fxMain.gain = 0f
    ownSeekUntil = now() + 3000
    player.seekTo(p.bIndex, (s.currentPosition + 250).coerceAtLeast(0))
    if (!player.playWhenReady) player.play()
  }

  override fun onCreate() {
    super.onCreate()
    // A copy of the audio goes to the visualizer (Spectrum), which ignores it unless it's open.
    val renderers = object : DefaultRenderersFactory(this) {
      override fun buildAudioSink(context: android.content.Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink =
        DefaultAudioSink.Builder(context)
          .setEnableFloatOutput(enableFloatOutput)
          .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
          .setAudioProcessors(arrayOf(fxMain, TeeAudioProcessor(Spectrum)))
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
    Outputs.apply(this, player)
    PlayLog.attach(this, player)
    player.addListener(object : Player.Listener {
      private var errors = 0

      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        val ours = now() < ownSeekUntil
        when {
          ours -> {}
          // A ran out on its own during the transition: take over now.
          phase == Phase.OVERLAP && reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && player.currentMediaItemIndex == plan?.bIndex ->
            side?.let { s -> plan?.let { beginHandover(it, s) } }
          phase != Phase.IDLE -> cancelMix()
          else -> tail = null
        }
        if (!ours) replanSafe()
        updateNorms()
        checkPlaying()
        saveQueue()
      }

      override fun onTimelineChanged(timeline: Timeline, reason: Int) {
        replanSafe()
        updateNorms()
        saveQueue()
      }

      override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
        // The user moved in the song during a transition: forget it.
        if (reason == Player.DISCONTINUITY_REASON_SEEK && now() >= ownSeekUntil && phase != Phase.IDLE) cancelMix()
      }

      override fun onPlaybackStateChanged(playbackState: Int) {
        if (playbackState == Player.STATE_READY) replanSafe()
      }

      override fun onRepeatModeChanged(repeatMode: Int) = replanSafe()
      override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) = replanSafe()

      override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) errors = 0
        kick()
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
    normOn = savedNormalize()
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
    handler.removeCallbacksAndMessages(null)
    side?.release()
    side = null
    normWorker.shutdownNow()
    scanWorker.shutdownNow()
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
