package app.aurora.mobile

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import org.json.JSONObject
import java.io.File
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.tan

/**
 * Volume sync on the phone: how loud each song really sounds (EBU R128 /
 * ITU-R BS.1770 integrated loudness, the same measurement as the desktop
 * app's loudness.rs), and how much to turn it up or down so every song
 * plays at about the same level. Songs are decoded with Android's own
 * decoders into memory; the files are only read, never changed.
 * Results are kept in loudness-phone.json (path → loudness, peak, size, date).
 */
object Loudness {
  class Result(val lufs: Double, val peak: Double)

  /** Same as mixmath.ts: aim for -14 LUFS, at most -15/+10 dB, never boost past the peak. */
  private const val TARGET = -14.0

  fun gain(l: Result): Float {
    var db = (TARGET - l.lufs).coerceIn(-15.0, 10.0)
    if (db > 0 && l.peak > 0) db = max(0.0, min(db, -20 * log10(l.peak) - 0.5))
    return 10.0.pow(db / 20).toFloat()
  }

  private var cache: JSONObject? = null

  private fun file(context: Context) = File(context.dataDir, "loudness-phone.json")

  @Synchronized
  private fun map(context: Context): JSONObject {
    cache?.let { return it }
    val m = try {
      JSONObject(file(context).readText())
    } catch (e: Exception) {
      JSONObject()
    }
    cache = m
    return m
  }

  /** The saved result, if the file hasn't changed since. */
  @Synchronized
  fun known(context: Context, path: String): Result? {
    val e = map(context).optJSONObject(path) ?: return null
    val f = File(path)
    if (e.optLong("size") != f.length() || e.optLong("mtime") != f.lastModified() / 1000) return null
    return Result(e.optDouble("lufs"), e.optDouble("peak"))
  }

  @Synchronized
  private fun save(context: Context, path: String, r: Result) {
    val m = map(context)
    val f = File(path)
    m.put(path, JSONObject().put("lufs", r.lufs).put("peak", r.peak).put("size", f.length()).put("mtime", f.lastModified() / 1000))
    if (m.length() % 50 == 0) {
      val gone = m.keys().asSequence().filter { !File(it).exists() }.toList()
      for (k in gone) m.remove(k)
    }
    try {
      file(context).writeText(m.toString())
    } catch (e: Exception) {
    }
  }

  /** Saved or measured now (slow: call off the main thread). Null if the song can't be read. */
  fun of(context: Context, path: String): Result? {
    known(context, path)?.let { return it }
    val r = measure(path) ?: return null
    save(context, path, r)
    return r
  }

  /** One K-weighting stage (BS.1770), designed for the sample rate (as in libebur128). */
  private class Stage(val b0: Double, val b1: Double, val b2: Double, val a1: Double, val a2: Double) {
    private val z = Array(8) { DoubleArray(2) }

    fun run(x: Double, c: Int): Double {
      val s = z[c]
      val y = b0 * x + s[0]
      s[0] = b1 * x - a1 * y + s[1]
      s[1] = b2 * x - a2 * y
      return y
    }

    companion object {
      fun shelf(rate: Double): Stage {
        val f0 = 1681.974450955533
        val g = 3.999843853973347
        val q = 0.7071752369554196
        val k = tan(PI * f0 / rate)
        val vh = 10.0.pow(g / 20)
        val vb = vh.pow(0.4996667741545416)
        val a0 = 1 + k / q + k * k
        return Stage((vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0)
      }

      fun highpass(rate: Double): Stage {
        val f0 = 38.13547087602444
        val q = 0.5003270373238773
        val k = tan(PI * f0 / rate)
        val a0 = 1 + k / q + k * k
        return Stage(1.0, -2.0, 1.0, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0)
      }
    }
  }

  /** Gated integrated loudness: 400 ms blocks, 75% overlap, -70 LUFS and -10 LU gates. */
  private class Meter(val rate: Int, val channels: Int) {
    private val s1 = Stage.shelf(rate.toDouble())
    private val s2 = Stage.highpass(rate.toDouble())
    private val step = max(1, rate / 10)
    private val sums = ArrayList<Double>()
    private var acc = 0.0
    private var n = 0
    var peak = 0.0
    private val frame = DoubleArray(max(1, channels))

    /** Like the desktop app (which mixes to stereo): a mono song counts in both ears. */
    private val weight = if (channels == 1) 2.0 else 1.0

    fun add(v: Double, ch: Int) {
      if (ch < 8) frame[ch] = v
      if (ch == channels - 1) {
        for (c in 0 until min(channels, 8)) {
          val x = frame[c]
          peak = max(peak, abs(x))
          val y = s2.run(s1.run(x, c), c)
          acc += y * y * weight
        }
        if (++n == step) {
          sums.add(acc)
          acc = 0.0
          n = 0
        }
      }
    }

    fun result(): Result {
      val lk = { z: Double -> -0.691 + 10 * log10(max(z, 1e-12)) }
      val blocks = (0..sums.size - 4).map { i -> (sums[i] + sums[i + 1] + sums[i + 2] + sums[i + 3]) / (4.0 * step) }
      val abs = blocks.filter { lk(it) > -70 }
      if (abs.isEmpty()) return Result(-70.0, peak)
      val rel = lk(abs.average()) - 10
      val gated = abs.filter { lk(it) > rel }
      return Result(lk(if (gated.isEmpty()) abs.average() else gated.average()), peak)
    }
  }

  private fun measure(path: String): Result? {
    val ex = MediaExtractor()
    var codec: MediaCodec? = null
    try {
      ex.setDataSource(path)
      val track = (0 until ex.trackCount).firstOrNull { ex.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true } ?: return null
      val format = ex.getTrackFormat(track)
      ex.selectTrack(track)
      val c = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
      codec = c
      c.configure(format, null, null, 0)
      c.start()
      var rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      var float = false
      var meter = Meter(rate, channels)
      val info = MediaCodec.BufferInfo()
      var inputDone = false
      var any = false
      while (true) {
        if (!inputDone) {
          val i = c.dequeueInputBuffer(5000)
          if (i >= 0) {
            val buf = c.getInputBuffer(i)!!
            val n = ex.readSampleData(buf, 0)
            if (n < 0) {
              c.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              c.queueInputBuffer(i, 0, n, ex.sampleTime, 0)
              ex.advance()
            }
          }
        }
        val o = c.dequeueOutputBuffer(info, 5000)
        if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          val f = c.outputFormat
          rate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE)
          channels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
          float = f.containsKey(MediaFormat.KEY_PCM_ENCODING) && f.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_FLOAT
          if (!any) meter = Meter(rate, channels)
        } else if (o >= 0) {
          val buf = c.getOutputBuffer(o)!!.order(ByteOrder.nativeOrder())
          buf.position(info.offset)
          buf.limit(info.offset + info.size)
          val samples = info.size / (if (float) 4 else 2)
          for (k in 0 until samples) {
            val v = if (float) buf.float.toDouble() else buf.short / 32768.0
            meter.add(v, k % max(1, channels))
          }
          if (samples > 0) any = true
          c.releaseOutputBuffer(o, false)
          if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
        }
      }
      return if (any) meter.result() else null
    } catch (e: Exception) {
      return null
    } finally {
      try {
        codec?.stop()
      } catch (e: Exception) {
      }
      codec?.release()
      ex.release()
    }
  }
}
