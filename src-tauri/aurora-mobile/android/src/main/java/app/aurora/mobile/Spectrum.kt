package app.aurora.mobile

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.TeeAudioProcessor
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Sound levels for the visualizer, read from the audio ExoPlayer is about to
 * play (a TeeAudioProcessor copy), so no microphone permission is needed.
 * It only does work while the visualizer is open (`active`).
 */
@OptIn(UnstableApi::class)
object Spectrum : TeeAudioProcessor.AudioBufferSink {
  private const val FFT = 2048
  private const val RING = 1 shl 16 // ~1.5 s of mono samples

  @Volatile
  var active = false

  private val ring = FloatArray(RING)
  private var written = 0L
  private var rate = 44100
  private var channels = 2
  private var encoding = C.ENCODING_PCM_16BIT
  @Volatile
  private var lastWrite = 0L

  private val window = FloatArray(FFT) { i -> (0.5 - 0.5 * cos(2 * PI * i / (FFT - 1))).toFloat() }
  private val re = FloatArray(FFT)
  private val im = FloatArray(FFT)

  override fun flush(sampleRateHz: Int, channelCount: Int, encoding: Int) {
    synchronized(ring) {
      rate = if (sampleRateHz > 0) sampleRateHz else 44100
      channels = max(1, channelCount)
      this.encoding = encoding
    }
  }

  override fun handleBuffer(buffer: ByteBuffer) {
    if (!active) return
    val b = buffer.duplicate().order(ByteOrder.nativeOrder())
    synchronized(ring) {
      val ch = channels
      when (encoding) {
        C.ENCODING_PCM_16BIT -> {
          val frames = b.remaining() / (2 * ch)
          for (f in 0 until frames) {
            var s = 0f
            for (c in 0 until ch) s += b.short / 32768f
            ring[(written and (RING - 1).toLong()).toInt()] = s / ch
            written++
          }
        }
        C.ENCODING_PCM_FLOAT -> {
          val frames = b.remaining() / (4 * ch)
          for (f in 0 until frames) {
            var s = 0f
            for (c in 0 until ch) s += b.float
            ring[(written and (RING - 1).toLong()).toInt()] = s / ch
            written++
          }
        }
        else -> return
      }
    }
    lastWrite = System.nanoTime()
  }

  /**
   * `count` levels from 0 to 255, low to high frequencies on a log scale
   * (40 Hz to 16 kHz). Silence when nothing has played for a moment.
   */
  fun bands(count: Int): IntArray {
    val out = IntArray(count)
    if (System.nanoTime() - lastWrite > 400_000_000L) return out
    val sr: Int
    synchronized(ring) {
      sr = rate
      // The copy runs ahead of the speaker by the output buffer (~¼ s): look back that far.
      val end = written - (sr / 4)
      if (end < FFT) return out
      for (i in 0 until FFT) {
        re[i] = ring[((end - FFT + i) and (RING - 1).toLong()).toInt()] * window[i]
        im[i] = 0f
      }
    }
    fft(re, im)
    val binHz = sr.toFloat() / FFT
    val lo = 40f
    val hi = min(16000f, sr / 2f - binHz)
    for (b in 0 until count) {
      val f0 = lo * (hi / lo).pow(b.toFloat() / count)
      val f1 = lo * (hi / lo).pow((b + 1).toFloat() / count)
      val i0 = max(1, (f0 / binHz).toInt())
      val i1 = max(i0, min(FFT / 2 - 1, (f1 / binHz).toInt()))
      var peak = 0f
      for (i in i0..i1) {
        val m = sqrt(re[i] * re[i] + im[i] * im[i])
        if (m > peak) peak = m
      }
      // Full-scale sine through a Hann window ≈ FFT/4. Show −75 … −15 dB.
      val db = 20f * log10(peak / (FFT / 4f) + 1e-9f)
      out[b] = (((db + 75f) / 60f).coerceIn(0f, 1f) * 255f).toInt()
    }
    return out
  }

  /** In-place radix-2 FFT. */
  private fun fft(x: FloatArray, y: FloatArray) {
    val n = x.size
    var j = 0
    for (i in 1 until n) {
      var bit = n shr 1
      while (j and bit != 0) {
        j = j xor bit
        bit = bit shr 1
      }
      j = j xor bit
      if (i < j) {
        val tx = x[i]; x[i] = x[j]; x[j] = tx
        val ty = y[i]; y[i] = y[j]; y[j] = ty
      }
    }
    var len = 2
    while (len <= n) {
      val ang = -2 * PI / len
      val wr = cos(ang).toFloat()
      val wi = sin(ang).toFloat()
      var i = 0
      while (i < n) {
        var cr = 1f
        var ci = 0f
        for (k in 0 until len / 2) {
          val a = i + k
          val b = a + len / 2
          val tr = x[b] * cr - y[b] * ci
          val ti = x[b] * ci + y[b] * cr
          x[b] = x[a] - tr; y[b] = y[a] - ti
          x[a] += tr; y[a] += ti
          val nr = cr * wr - ci * wi
          ci = cr * wi + ci * wr
          cr = nr
        }
        i += len
      }
      len = len shl 1
    }
  }
}
