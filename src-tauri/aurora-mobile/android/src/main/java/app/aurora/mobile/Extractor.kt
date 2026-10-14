package app.aurora.mobile

import android.content.Context
import android.net.Uri
import app.tauri.plugin.JSObject
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import org.schabi.newpipe.extractor.Image
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import org.schabi.newpipe.extractor.services.youtube.linkHandler.YoutubeSearchQueryHandlerFactory
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.DeliveryMethod
import org.schabi.newpipe.extractor.stream.StreamInfo
import org.schabi.newpipe.extractor.stream.StreamInfoItem
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.Collections
import java.util.concurrent.TimeUnit

private const val USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0"

/** NewPipe Extractor's way of making web requests, done with OkHttp. */
private class OkDownloader(private val client: OkHttpClient) : Downloader() {
  override fun execute(request: Request): Response {
    val data = request.dataToSend()
    val method = request.httpMethod()
    val body = when {
      data != null -> data.toRequestBody(null)
      method == "POST" || method == "PUT" -> ByteArray(0).toRequestBody(null)
      else -> null
    }
    val builder = okhttp3.Request.Builder().url(request.url()).method(method, body).header("User-Agent", USER_AGENT)
    for ((name, values) in request.headers()) {
      builder.removeHeader(name)
      for (v in values) builder.addHeader(name, v)
    }
    client.newCall(builder.build()).execute().use { r ->
      if (r.code == 429) throw ReCaptchaException("Too many requests; try again in a while.", request.url())
      return Response(r.code, r.message, r.headers.toMultimap(), r.body?.string(), r.request.url.toString())
    }
  }
}

class Canceled : Exception("canceled")

/**
 * Search, preview and download for the phone version. There's no yt-dlp or
 * FFmpeg on Android, so this uses NewPipe Extractor and saves the audio the
 * site serves without converting it.
 */
object Extractor {
  val http: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .connectTimeout(20, TimeUnit.SECONDS)
      .readTimeout(40, TimeUnit.SECONDS)
      .followRedirects(true)
      .build()
  }

  @Volatile private var ready = false
  private val canceled: MutableSet<String> = Collections.synchronizedSet(HashSet())

  fun init() {
    if (ready) return
    synchronized(this) {
      if (!ready) {
        NewPipe.init(OkDownloader(http))
        ready = true
      }
    }
  }

  private fun best(images: List<Image>): String? = images.maxByOrNull { it.height * it.width }?.url

  /** `site`: youtube, youtube-music (songs only) or soundcloud. */
  fun search(site: String, query: String, limit: Int): List<JSObject> {
    init()
    val service = if (site == "soundcloud") ServiceList.SoundCloud else ServiceList.YouTube
    val filter = when (site) {
      "youtube-music" -> listOf(YoutubeSearchQueryHandlerFactory.MUSIC_SONGS)
      "youtube" -> listOf(YoutubeSearchQueryHandlerFactory.VIDEOS)
      else -> listOf("tracks")
    }
    val extractor = service.getSearchExtractor(query, filter, "")
    extractor.fetchPage()
    val found = ArrayList<StreamInfoItem>()
    var page = extractor.initialPage
    found.addAll(page.items.filterIsInstance<StreamInfoItem>())
    var pages = 1
    while (found.size < limit && page.hasNextPage() && pages < 3) {
      page = extractor.getPage(page.nextPage)
      found.addAll(page.items.filterIsInstance<StreamInfoItem>())
      pages++
    }
    return found.take(limit).map { item ->
      JSObject().apply {
        put("id", item.url)
        put("url", item.url)
        put("title", item.name)
        put("channel", item.uploaderName)
        put("durationMs", maxOf(0L, item.duration) * 1000L)
        if (item.viewCount >= 0) put("views", item.viewCount)
        put("thumb", best(item.thumbnails))
      }
    }
  }

  private fun suffix(s: AudioStream) = s.format?.suffix ?: ""

  /**
   * The stream to download or play: M4A first (taggable, plays everywhere), then MP3, then anything.
   * `small` (space saver) takes the smallest M4A YouTube offers (about 48 kbps) instead of the best.
   */
  private fun pick(streams: List<AudioStream>, forDownload: Boolean, small: Boolean = false): AudioStream? {
    val original = streams.filter { it.audioTrackType == null || it.audioTrackType?.name == "ORIGINAL" }.ifEmpty { streams }
    val progressive = original.filter { it.deliveryMethod == DeliveryMethod.PROGRESSIVE_HTTP && it.isUrl }
    val byRate = compareBy<AudioStream> { it.averageBitrate }
    val m4a = progressive.filter { suffix(it) == "m4a" }
    (if (small) m4a.filter { it.averageBitrate > 0 }.minWithOrNull(byRate) ?: m4a.minWithOrNull(byRate) else m4a.maxWithOrNull(byRate))?.let { return it }
    progressive.filter { suffix(it) == "mp3" }.maxWithOrNull(byRate)?.let { return it }
    if (!forDownload) progressive.maxWithOrNull(byRate)?.let { return it }
    // SoundCloud often only offers HLS; MP3 segments can simply be joined.
    original.filter { it.deliveryMethod == DeliveryMethod.HLS && suffix(it) == "mp3" }.maxWithOrNull(byRate)?.let { return it }
    progressive.maxWithOrNull(byRate)?.let { return it }
    if (!forDownload) original.firstOrNull { it.deliveryMethod == DeliveryMethod.HLS }?.let { return it }
    return null
  }

  /** A URL the preview player can play directly. */
  fun stream(url: String): String {
    init()
    val info = StreamInfo.getInfo(url)
    val s = pick(info.audioStreams, forDownload = false) ?: throw IOException("This upload has no playable audio.")
    return s.content
  }

  fun cancel(job: String) {
    canceled.add(job)
  }

  private fun check(job: String) {
    if (canceled.contains(job)) throw Canceled()
  }

  private fun safe(name: String): String {
    val cleaned = name.map { c -> if ("<>:\"/\\|?*".indexOf(c) >= 0 || c.isISOControl()) '_' else c }.joinToString("")
    return cleaned.trim().trimEnd('.', ' ').take(150).ifEmpty { "Untitled" }
  }

  /**
   * Downloads the audio of `url` to `<dir>/<stem>.<ext>` and returns
   * { path, title, artist, thumb }. Calls `progress(percent, speed, eta)`.
   */
  fun download(
    context: Context,
    job: String,
    url: String,
    dir: String,
    stem: String?,
    small: Boolean,
    progress: (Double, String, String) -> Unit,
  ): JSObject {
    init()
    canceled.remove(job)
    val info = StreamInfo.getInfo(url)
    check(job)
    val s = pick(info.audioStreams, forDownload = true, small = small) ?: throw IOException("No downloadable audio for this upload.")
    val ext = when (suffix(s)) {
      "m4a", "mp3", "opus", "ogg" -> suffix(s)
      "webm", "weba" -> "webm"
      else -> "m4a"
    }
    val folder = File(dir).apply { mkdirs() }
    val base = stem ?: safe("${info.uploaderName.removeSuffix(" - Topic")} - ${info.name}")
    var out = File(folder, "$base.$ext")
    var n = 2
    while (stem == null && out.exists()) out = File(folder, "$base ($n).${ext}").also { n++ }
    val part = File(folder, ".$base.$ext.part")

    try {
      if (s.deliveryMethod == DeliveryMethod.HLS) hls(job, s.content, part, progress)
      else fetch(job, s.content, part, progress)
      check(job)
      // (YouTube's M4A arrives fragmented; Aurora's Rust side rebuilds it into
      // an ordinary file right after this, without re-encoding.)
      if (!part.renameTo(out)) throw IOException("Couldn't save ${out.name}.")
    } catch (e: Exception) {
      part.delete()
      throw e
    } finally {
      canceled.remove(job)
    }
    progress(100.0, "", "")
    return JSObject().apply {
      put("path", out.absolutePath)
      put("title", info.name)
      put("artist", info.uploaderName)
      put("thumb", best(info.thumbnails))
    }
  }

  private fun speedText(bytesPerSec: Double) = when {
    bytesPerSec > 1e6 -> String.format("%.1fMiB/s", bytesPerSec / 1048576.0)
    else -> String.format("%.0fKiB/s", bytesPerSec / 1024.0)
  }

  private fun etaText(sec: Long) = if (sec < 0) "" else String.format("%02d:%02d", sec / 60, sec % 60)

  /** Plain download in 4 MB ranges (YouTube slows down long single requests). */
  private fun fetch(job: String, url: String, to: File, progress: (Double, String, String) -> Unit) {
    val chunk = 4L * 1024 * 1024
    val known = Uri.parse(url).getQueryParameter("clen")?.toLongOrNull()
    var total = known ?: -1L
    var done = 0L
    val started = System.nanoTime()
    var lastReport = 0L
    FileOutputStream(to).use { file ->
      while (total < 0 || done < total) {
        check(job)
        val end = done + chunk - 1
        val req = okhttp3.Request.Builder().url(url).header("User-Agent", USER_AGENT).header("Range", "bytes=$done-$end").build()
        http.newCall(req).execute().use { r ->
          if (r.code == 416) return
          if (!r.isSuccessful) throw IOException("HTTP ${r.code} while downloading")
          if (total < 0) {
            total = r.header("Content-Range")?.substringAfter('/')?.toLongOrNull()
              ?: if (r.code == 200) (r.body?.contentLength() ?: -1L) else -1L
          }
          val body = r.body ?: throw IOException("Empty response")
          val buf = ByteArray(64 * 1024)
          body.byteStream().use { input ->
            while (true) {
              val read = input.read(buf)
              if (read < 0) break
              file.write(buf, 0, read)
              done += read
              val now = System.nanoTime()
              if (now - lastReport > 250_000_000L) {
                lastReport = now
                check(job)
                val secs = (now - started) / 1e9
                val speed = if (secs > 0) done / secs else 0.0
                val pct = if (total > 0) done * 100.0 / total else 0.0
                val eta = if (total > 0 && speed > 0) ((total - done) / speed).toLong() else -1L
                progress(minOf(pct, 99.9), speedText(speed), etaText(eta))
              }
            }
          }
          // A server that ignores Range sends everything at once.
          if (r.code == 200) return
          if (total < 0) return
        }
      }
    }
  }

  /** HLS: download the segments in order and join them (works for MP3). */
  private fun hls(job: String, url: String, to: File, progress: (Double, String, String) -> Unit) {
    fun get(u: String): String {
      val req = okhttp3.Request.Builder().url(u).header("User-Agent", USER_AGENT).build()
      http.newCall(req).execute().use { r ->
        if (!r.isSuccessful) throw IOException("HTTP ${r.code}")
        return r.body?.string() ?: ""
      }
    }
    var playlistUrl = url
    var text = get(playlistUrl)
    // A master playlist: take its first variant.
    if (text.contains("#EXT-X-STREAM-INF")) {
      val variant = text.lines().map { it.trim() }.firstOrNull { it.isNotEmpty() && !it.startsWith("#") }
        ?: throw IOException("Empty playlist")
      playlistUrl = resolve(playlistUrl, variant)
      text = get(playlistUrl)
    }
    val lines = text.lines().map { it.trim() }
    val init = lines.firstOrNull { it.startsWith("#EXT-X-MAP") }?.let { Regex("URI=\"([^\"]+)\"").find(it)?.groupValues?.get(1) }
    val segments = lines.filter { it.isNotEmpty() && !it.startsWith("#") }.map { resolve(playlistUrl, it) }
    if (segments.isEmpty()) throw IOException("Empty playlist")
    val started = System.nanoTime()
    var bytes = 0L
    FileOutputStream(to).use { file ->
      val all = listOfNotNull(init?.let { resolve(playlistUrl, it) }) + segments
      all.forEachIndexed { i, seg ->
        check(job)
        val req = okhttp3.Request.Builder().url(seg).header("User-Agent", USER_AGENT).build()
        http.newCall(req).execute().use { r ->
          if (!r.isSuccessful) throw IOException("HTTP ${r.code} on part ${i + 1}")
          val data = r.body?.bytes() ?: ByteArray(0)
          file.write(data)
          bytes += data.size
        }
        val secs = (System.nanoTime() - started) / 1e9
        val pct = (i + 1) * 100.0 / all.size
        val eta = if (i > 0) (secs / (i + 1) * (all.size - i - 1)).toLong() else -1L
        progress(minOf(pct, 99.9), speedText(if (secs > 0) bytes / secs else 0.0), etaText(eta))
      }
    }
  }

  private fun resolve(base: String, ref: String): String =
    if (ref.startsWith("http")) ref else java.net.URI(base).resolve(ref).toString()
}
