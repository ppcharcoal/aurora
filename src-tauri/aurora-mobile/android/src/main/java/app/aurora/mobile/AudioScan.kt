package app.aurora.mobile

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Reads songs for transitions, on the phone: the loudness outline for the
 * transition editor, and where the music really starts and ends (for
 * "Smooth"). Decodes with Android's own decoders into memory; the file is
 * only read, never changed. (The desktop app does the same with FFmpeg.)
 */
object AudioScan {
  class Bounds(val leadMs: Double, val endMs: Double)

  /** -48 dBFS: quieter counts as silence (same as the desktop app). */
  private const val QUIET = 130.0 / 32768.0

  /**
   * Calls `sample(ms, level)` for every decoded sample (mono, 0–1) between
   * startMs and startMs + durMs. Returns false if the file couldn't be read.
   */
  private fun decode(path: String, startMs: Double, durMs: Double, sample: (Double, Double) -> Unit): Boolean {
    val ex = MediaExtractor()
    var codec: MediaCodec? = null
    try {
      ex.setDataSource(path)
      val track = (0 until ex.trackCount).firstOrNull { ex.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true } ?: return false
      val format = ex.getTrackFormat(track)
      ex.selectTrack(track)
      val startUs = (startMs * 1000).toLong()
      val endUs = ((startMs + durMs) * 1000).toLong()
      ex.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
      val c = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
      codec = c
      c.configure(format, null, null, 0)
      c.start()
      var rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      var float = false
      val info = MediaCodec.BufferInfo()
      var inputDone = false
      var done = false
      while (!done) {
        if (!inputDone) {
          val i = c.dequeueInputBuffer(5000)
          if (i >= 0) {
            val buf = c.getInputBuffer(i)!!
            val n = ex.readSampleData(buf, 0)
            if (n < 0 || ex.sampleTime > endUs + 500_000) {
              c.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              c.queueInputBuffer(i, 0, n, ex.sampleTime, 0)
              ex.advance()
            }
          }
        }
        val o = c.dequeueOutputBuffer(info, 5000)
        when {
          o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            val f = c.outputFormat
            rate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            channels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            float = f.containsKey(MediaFormat.KEY_PCM_ENCODING) && f.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_FLOAT
          }
          o >= 0 -> {
            val buf = c.getOutputBuffer(o)!!.order(ByteOrder.nativeOrder())
            buf.position(info.offset)
            buf.limit(info.offset + info.size)
            val frames = info.size / ((if (float) 4 else 2) * max(1, channels))
            for (k in 0 until frames) {
              var peak = 0.0
              for (ch in 0 until channels) {
                val v = if (float) buf.float.toDouble() else buf.short / 32768.0
                peak = max(peak, abs(v))
              }
              val us = info.presentationTimeUs + k * 1_000_000L / rate
              if (us in startUs until endUs) sample(us / 1000.0, peak)
            }
            c.releaseOutputBuffer(o, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0 || info.presentationTimeUs > endUs) done = true
          }
        }
      }
      return true
    } catch (e: Exception) {
      return false
    } finally {
      try {
        codec?.stop()
      } catch (e: Exception) {
      }
      codec?.release()
      ex.release()
    }
  }

  /** Loudness outline: `points` values 0–255 (same curve as the desktop app). */
  fun peaks(path: String, startMs: Double, durMs: Double, points: Int): IntArray? {
    val n = points.coerceIn(16, 4000)
    val max = DoubleArray(n)
    val ok = decode(path, startMs, durMs) { ms, v ->
      val i = (((ms - startMs) / durMs) * n).toInt()
      if (i in 0 until n && v > max[i]) max[i] = v
    }
    if (!ok) return null
    return IntArray(n) { min(255, (sqrt(max[it]) * 255).roundToInt()) }
  }

  /** Where the music starts and stops (ignoring silence at either end). */
  fun bounds(path: String, durationMs: Double): Bounds? {
    val look = min(20_000.0, max(1.0, durationMs))
    var lead = -1.0
    if (!decode(path, 0.0, look) { ms, v -> if (lead < 0 && v > QUIET) lead = ms }) return null
    val from = max(0.0, durationMs - 20_000)
    var end = -1.0
    decode(path, from, 20_000.0) { ms, v -> if (v > QUIET) end = ms }
    val l = max(0.0, (if (lead < 0) 0.0 else lead) - 40).coerceAtMost(durationMs / 2)
    val e = (if (end < 0) durationMs else end + 150).coerceAtMost(durationMs).coerceAtLeast(durationMs / 2)
    return Bounds(l, e)
  }
}
