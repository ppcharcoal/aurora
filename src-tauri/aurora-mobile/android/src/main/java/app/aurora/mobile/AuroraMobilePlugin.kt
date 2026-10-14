package app.aurora.mobile

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.os.Build
import androidx.activity.result.ActivityResult
import app.tauri.PermissionState
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import android.content.ComponentName
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import app.tauri.Logger
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import java.io.File
import java.util.concurrent.Executors

@InvokeArg
class SearchArgs {
  lateinit var site: String
  lateinit var query: String
  var limit: Int = 20
}

@InvokeArg
class UrlArgs {
  lateinit var url: String
}

@InvokeArg
class DownloadArgs {
  lateinit var job: String
  lateinit var url: String
  lateinit var dir: String
  var stem: String? = null
  /** Space saver: the smallest audio stream instead of the best. */
  var small: Boolean = false
}

@InvokeArg
class JobArgs {
  lateinit var job: String
}

@InvokeArg
class QueueItem {
  lateinit var id: String
  lateinit var path: String
  var title: String? = null
  var artist: String? = null
  var album: String? = null
}

@InvokeArg
class QueueArgs {
  lateinit var items: Array<QueueItem>
  var index: Int = 0
  var positionMs: Long = 0
  var play: Boolean = true
  /** Same song keeps playing; only the songs around it changed. */
  var keep: Boolean = false
}

@InvokeArg
class ControlArgs {
  lateinit var action: String
  var value: Double? = null
}

@InvokeArg
class OutputArgs {
  var id: String? = null
}

/**
 * The bridge between Aurora's screens and Android:
 *  - search / stream / download / cancel: called from Rust (no yt-dlp on phones)
 *  - queue / control / state: drive the playback service; "state" events report back
 *  - outputs / output: audio devices; "outputs" events when they change
 *  - plays: listening done while the app wasn't open, for stats and Last.fm
 */
@InvokeArg
class DocumentArgs {
  var name: String? = null
}

@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.READ_MEDIA_AUDIO], alias = "audio"),
    Permission(strings = [Manifest.permission.READ_EXTERNAL_STORAGE], alias = "storage"),
  ],
)
class AuroraMobilePlugin(private val activity: Activity) : Plugin(activity) {
  private val main = Handler(Looper.getMainLooper())
  private val io = Executors.newFixedThreadPool(3)
  private var future: ListenableFuture<MediaController>? = null
  private var controller: MediaController? = null
  private val waiting = mutableListOf<(MediaController) -> Unit>()
  private var lastIds: List<String> = emptyList()
  private var ticking = false

  override fun load(webView: WebView) {
    super.load(webView)
    // Android's "font size" setting scales all text in the app. Follow it, but only
    // up to 115%: beyond that buttons and labels stop fitting a phone screen.
    webView.settings.textZoom = webView.settings.textZoom.coerceIn(85, 115)
    io.execute {
      try {
        Extractor.init()
      } catch (e: Exception) {
        Logger.error("Aurora: extractor init failed: ${e.message}")
      }
    }
    Outputs.watch(activity) { trigger("outputs", JSObject().put("devices", Outputs.list(activity))) }
    main.post { connect() }
  }

  override fun onDestroy() {
    future?.let { MediaController.releaseFuture(it) }
    future = null
    controller = null
    super.onDestroy()
  }

  /* ------------------------------ playback ------------------------------ */

  private val listener = object : Player.Listener {
    override fun onEvents(player: Player, events: Player.Events) {
      emit(false)
      tick()
    }
  }

  /** Runs `block` with a connected controller (connects to the service first if needed). Main thread. */
  private fun connect(block: ((MediaController) -> Unit)? = null) {
    controller?.let { c ->
      block?.invoke(c)
      return
    }
    block?.let { waiting.add(it) }
    if (future != null) return
    val token = SessionToken(activity, ComponentName(activity, PlaybackService::class.java))
    val f = MediaController.Builder(activity, token).buildAsync()
    future = f
    f.addListener({
      try {
        val c = f.get()
        controller = c
        c.addListener(listener)
        emit(true)
        val todo = waiting.toList()
        waiting.clear()
        todo.forEach { it(c) }
      } catch (e: Exception) {
        Logger.error("Aurora: can't reach the playback service: ${e.message}")
        future = null
        waiting.clear()
      }
    }, MoreExecutors.directExecutor())
  }

  private fun onPlayer(invoke: Invoke, block: (MediaController) -> Unit) {
    main.post {
      connect { c ->
        try {
          block(c)
          invoke.resolve()
        } catch (e: Exception) {
          invoke.reject(e.message ?: "Playback error")
        }
      }
    }
  }

  private fun snapshot(c: MediaController, withIds: Boolean): JSObject {
    val ids = (0 until c.mediaItemCount).map { Library.trackId(c.getMediaItemAt(it).mediaId) }
    val o = JSObject()
    if (withIds || ids != lastIds) {
      lastIds = ids
      o.put("ids", JSArray(ids))
    }
    o.put("index", c.currentMediaItemIndex)
    o.put("playing", c.isPlaying || (c.playWhenReady && c.playbackState == Player.STATE_BUFFERING))
    o.put("loading", c.playbackState == Player.STATE_BUFFERING)
    o.put("positionMs", maxOf(0L, c.currentPosition))
    o.put("durationMs", if (c.duration > 0) c.duration else 0L)
    o.put("repeat", when (c.repeatMode) { Player.REPEAT_MODE_ALL -> "all"; Player.REPEAT_MODE_ONE -> "one"; else -> "off" })
    c.playerError?.let { o.put("error", it.message ?: "Couldn't play this file") }
    return o
  }

  private fun emit(withIds: Boolean) {
    val c = controller ?: return
    trigger("state", snapshot(c, withIds))
  }

  /** While playing, report the position once a second (the app animates in between). */
  private fun tick() {
    if (ticking) return
    val c = controller ?: return
    if (!c.isPlaying) return
    ticking = true
    main.postDelayed({
      ticking = false
      emit(false)
      tick()
    }, 1000)
  }

  private fun toItem(q: QueueItem): MediaItem {
    val file = Uri.fromFile(File(q.path))
    val meta = MediaMetadata.Builder().setTitle(q.title).setArtist(q.artist).setAlbumTitle(q.album).build()
    return MediaItem.Builder()
      .setMediaId(q.id)
      .setUri(file)
      .setMediaMetadata(meta)
      // Survives the trip to the service, which fills in the rest from the library.
      .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(file).build())
      .build()
  }

  @Command
  fun queue(invoke: Invoke) {
    val args = invoke.parseArgs(QueueArgs::class.java)
    val items = args.items.map(::toItem)
    val k = args.index.coerceIn(0, maxOf(0, items.size - 1))
    onPlayer(invoke) { c ->
      val cur = c.currentMediaItemIndex
      val n = c.mediaItemCount
      val same = args.keep && n > 0 && cur in 0 until n && items.isNotEmpty() &&
        Library.trackId(c.getMediaItemAt(cur).mediaId) == args.items[k].id
      if (!same) {
        c.setMediaItems(items, k, args.positionMs)
        c.prepare()
        if (args.play) c.play()
      } else {
        // Replace everything around the current song without interrupting it.
        if (cur + 1 < n) c.removeMediaItems(cur + 1, n)
        if (k + 1 < items.size) c.addMediaItems(items.subList(k + 1, items.size))
        if (cur > 0) c.removeMediaItems(0, cur)
        if (k > 0) c.addMediaItems(0, items.subList(0, k))
      }
    }
  }

  @Command
  fun control(invoke: Invoke) {
    val args = invoke.parseArgs(ControlArgs::class.java)
    onPlayer(invoke) { c ->
      when (args.action) {
        "play" -> {
          if (c.playbackState == Player.STATE_IDLE) c.prepare()
          if (c.playbackState == Player.STATE_ENDED) c.seekToDefaultPosition(0)
          c.play()
        }
        "pause" -> c.pause()
        "next" -> c.seekToNext()
        "prev" -> c.seekToPrevious()
        "seek" -> c.seekTo(((args.value ?: 0.0)).toLong())
        "jump" -> {
          c.seekToDefaultPosition((args.value ?: 0.0).toInt())
          c.prepare()
          c.play()
        }
        "repeat" -> {
          c.repeatMode = when ((args.value ?: 0.0).toInt()) {
            1 -> Player.REPEAT_MODE_ALL
            2 -> Player.REPEAT_MODE_ONE
            else -> Player.REPEAT_MODE_OFF
          }
        }
        "volume" -> {
          c.volume = (args.value ?: 1.0).toFloat().coerceIn(0f, 1f)
        }
        "stop" -> {
          c.stop()
          c.clearMediaItems()
        }
        else -> throw IllegalArgumentException("Unknown action ${args.action}")
      }
    }
  }

  @Command
  fun state(invoke: Invoke) {
    main.post {
      connect { c -> invoke.resolve(snapshot(c, true)) }
    }
  }

  /** The library or playlists changed: refresh Android Auto's lists. */
  @Command
  fun reload(invoke: Invoke) {
    main.post {
      Library.invalidate()
      PlaybackService.current?.libraryChanged()
      invoke.resolve()
    }
  }

  @Command
  fun plays(invoke: Invoke) {
    io.execute {
      try {
        invoke.resolve(JSObject().put("plays", PlayLog.take(activity)))
      } catch (e: Exception) {
        invoke.reject(e.message)
      }
    }
  }

  /* ---------------------------- audio outputs ---------------------------- */

  @Command
  fun outputs(invoke: Invoke) {
    invoke.resolve(JSObject().put("devices", Outputs.list(activity)))
  }

  @Command
  fun output(invoke: Invoke) {
    val args = invoke.parseArgs(OutputArgs::class.java)
    main.post {
      Outputs.choose(activity, args.id)
      invoke.resolve()
    }
  }

  /* --------------------------- search / download --------------------------- */

  @Command
  fun search(invoke: Invoke) {
    val args = invoke.parseArgs(SearchArgs::class.java)
    io.execute {
      try {
        val items = JSArray()
        Extractor.search(args.site, args.query, args.limit).forEach { items.put(it) }
        invoke.resolve(JSObject().put("items", items))
      } catch (e: Exception) {
        invoke.reject(e.message ?: "Search failed")
      }
    }
  }

  @Command
  fun stream(invoke: Invoke) {
    val args = invoke.parseArgs(UrlArgs::class.java)
    io.execute {
      try {
        invoke.resolve(JSObject().put("url", Extractor.stream(args.url)))
      } catch (e: Exception) {
        invoke.reject(e.message ?: "Couldn't load the preview")
      }
    }
  }

  @Command
  fun download(invoke: Invoke) {
    val args = invoke.parseArgs(DownloadArgs::class.java)
    io.execute {
      try {
        val r = Extractor.download(activity, args.job, args.url, args.dir, args.stem, args.small) { pct, speed, eta ->
          trigger("progress", JSObject().put("id", args.job).put("percent", pct).put("speed", speed).put("eta", eta))
        }
        invoke.resolve(r)
      } catch (e: Canceled) {
        invoke.reject("canceled")
      } catch (e: Exception) {
        invoke.reject(e.message ?: "Download failed")
      }
    }
  }

  /* --------------------------- visualizer --------------------------- */

  private var vizOn = false
  private val vizTick = object : Runnable {
    override fun run() {
      if (!vizOn) return
      val arr = JSArray()
      for (v in Spectrum.bands(48)) arr.put(v)
      trigger("spectrum", JSObject().put("b", arr))
      main.postDelayed(this, 33)
    }
  }

  /** Sends sound levels ("spectrum" events, ~30 a second) until vizStop. */
  @Command
  fun vizStart(invoke: Invoke) {
    Spectrum.active = true
    if (!vizOn) {
      vizOn = true
      main.post(vizTick)
    }
    invoke.resolve()
  }

  @Command
  fun vizStop(invoke: Invoke) {
    vizOn = false
    Spectrum.active = false
    main.removeCallbacks(vizTick)
    invoke.resolve()
  }

  @Command
  fun cancel(invoke: Invoke) {
    val args = invoke.parseArgs(JobArgs::class.java)
    Extractor.cancel(args.job)
    invoke.resolve()
  }
  /* --------------------- files the user picks or already has --------------------- */

  /** Android 13+ asks for "music and audio"; older versions for storage. */
  private fun musicAlias() = if (Build.VERSION.SDK_INT >= 33) "audio" else "storage"

  private fun musicGranted() = getPermissionState(musicAlias()) == PermissionState.GRANTED

  /**
   * Where downloads go: Download/Aurora, visible in the Files app and over USB.
   * Android 11+ lets apps write their own files there without a permission;
   * older phones (or if it can't be written) use Aurora's own music folder.
   */
  @Command
  fun musicFolder(invoke: Invoke) {
    var dir: java.io.File? = null
    if (Build.VERSION.SDK_INT >= 30) {
      try {
        val d = java.io.File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS), "Aurora")
        d.mkdirs()
        val probe = java.io.File(d, ".aurora-probe")
        probe.writeText("ok")
        probe.delete()
        dir = d
      } catch (_: Exception) {
        dir = null
      }
    }
    val shared = dir != null
    if (dir == null) dir = java.io.File(activity.getExternalFilesDir(android.os.Environment.DIRECTORY_MUSIC), "Aurora").also { it.mkdirs() }
    invoke.resolve(JSObject().put("path", dir.absolutePath).put("shared", shared))
  }

  @Command
  fun musicAccess(invoke: Invoke) {
    if (musicGranted()) invoke.resolve(JSObject().put("granted", true))
    else requestPermissionForAlias(musicAlias(), invoke, "musicAccessResult")
  }

  @PermissionCallback
  fun musicAccessResult(invoke: Invoke) {
    invoke.resolve(JSObject().put("granted", musicGranted()))
  }

  @Command
  fun phoneFolders(invoke: Invoke) {
    if (!musicGranted()) {
      invoke.reject("Aurora needs permission to see the music on this phone.")
      return
    }
    io.execute {
      try {
        invoke.resolve(JSObject().put("folders", PhoneFiles.musicFolders(activity)))
      } catch (e: Exception) {
        invoke.reject(e.message ?: "Couldn't list the phone's music")
      }
    }
  }

  @Command
  fun pickImage(invoke: Invoke) {
    val intent = Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE)
    startActivityForResult(invoke, intent, "pickImageResult")
  }

  @ActivityCallback
  fun pickImageResult(invoke: Invoke, result: ActivityResult) {
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || uri == null) {
      invoke.resolve(JSObject().put("path", null as String?))
      return
    }
    io.execute {
      try {
        invoke.resolve(JSObject().put("path", PhoneFiles.copyImage(activity, uri)))
      } catch (e: Exception) {
        invoke.reject(e.message ?: "Couldn't read that picture")
      }
    }
  }

  /** "Save as" screen for a backup; returns an open file descriptor ({ fd: -1 } if cancelled). */
  @Command
  fun createDocument(invoke: Invoke) {
    val args = invoke.parseArgs(DocumentArgs::class.java)
    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
      .addCategory(Intent.CATEGORY_OPENABLE)
      .setType("application/zip")
      .putExtra(Intent.EXTRA_TITLE, args.name ?: "Aurora backup.zip")
    startActivityForResult(invoke, intent, "createDocumentResult")
  }

  @ActivityCallback
  fun createDocumentResult(invoke: Invoke, result: ActivityResult) = documentResult(invoke, result, write = true)

  /** "Open" screen for a backup zip; returns an open file descriptor ({ fd: -1 } if cancelled). */
  @Command
  fun openDocument(invoke: Invoke) {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
      .addCategory(Intent.CATEGORY_OPENABLE)
      .setType("*/*")
      .putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream"))
    startActivityForResult(invoke, intent, "openDocumentResult")
  }

  @ActivityCallback
  fun openDocumentResult(invoke: Invoke, result: ActivityResult) = documentResult(invoke, result, write = false)

  private fun documentResult(invoke: Invoke, result: ActivityResult, write: Boolean) {
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || uri == null) {
      invoke.resolve(JSObject().put("fd", -1))
      return
    }
    try {
      invoke.resolve(JSObject().put("fd", PhoneFiles.descriptor(activity, uri, write)))
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Couldn't open that file")
    }
  }
}
