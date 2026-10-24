package app.aurora.mobile

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Timeline
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Volume and effects for transitions, inside the player's audio path:
 * gain (smoothly moved to `gain`), then dampen (low-pass), bass (low shelf)
 * and treble (high shelf) like the desktop app. Neutral settings pass the
 * sound through unchanged. Only the sound being played is processed; the
 * music files are never touched.
 *
 * Volume sync multiplies on top: `norms` holds the level for each song
 * (media id → multiplier). Which song is coming through is read from the
 * stream info ExoPlayer hands over at each song change, so the new level
 * starts exactly with the new song, not when it's heard a moment later.
 */
@OptIn(UnstableApi::class)
class FxProcessor : BaseAudioProcessor() {
  /** Target volume 0–1; reached within one buffer. */
  @Volatile
  var gain = 1f

  /** Target effects. */
  @Volatile
  var fx: Fx = Fx.NONE

  /** Volume sync: media id → multiplier (empty when it's off). */
  @Volatile
  var norms: Map<String, Float> = emptyMap()

  /** The song coming through right now (media id). */
  @Volatile
  var playingId: String? = null

  /** Whether ExoPlayer said which song it is (otherwise the service sets `playingId`). */
  @Volatile
  var streamKnown = false
    private set

  private val window = Timeline.Window()
  private val period = Timeline.Period()
  private var current = 1f
  private var applied: Fx? = null
  private var rate = 44100
  private var channels = 2
  private var float = false
  private val lp = Biquad()
  private val lo = Biquad()
  private val hi = Biquad()
  private var filtersOn = false

  override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
    val enc = inputAudioFormat.encoding
    if (enc != C.ENCODING_PCM_16BIT && enc != C.ENCODING_PCM_FLOAT) throw AudioProcessor.UnhandledAudioFormatException(inputAudioFormat)
    rate = inputAudioFormat.sampleRate
    channels = inputAudioFormat.channelCount
    float = enc == C.ENCODING_PCM_FLOAT
    applied = null
    return inputAudioFormat
  }

  override fun queueInput(inputBuffer: ByteBuffer) {
    val size = inputBuffer.remaining()
    if (size == 0) return
    val out = replaceOutputBuffer(size)
    val norm = playingId?.let { norms[it] } ?: 1f
    val target = (gain.coerceIn(0f, 1f) * norm).coerceIn(0f, 4f)
    val f = fx
    if (f !== applied) {
      applied = f
      filtersOn = !f.neutral
      if (filtersOn) {
        lp.lowpass(20000.0 * (250.0 / 20000.0).pow(f.damp.coerceIn(0.0, 1.0)), rate)
        lo.shelf(110.0, f.bass.coerceIn(-1.0, 1.0) * 12, false, rate)
        hi.shelf(6000.0, f.treble.coerceIn(-1.0, 1.0) * 12, true, rate)
      }
    }
    val bytes = if (float) 4 else 2
    val frames = size / (bytes * channels)
    val start = current
    if (start == 1f && target == 1f && !filtersOn) {
      out.put(inputBuffer)
    } else {
      for (i in 0 until frames) {
        val g = start + (target - start) * (i.toFloat() / frames)
        for (ch in 0 until channels) {
          var x = if (float) inputBuffer.float.toDouble() else inputBuffer.short.toDouble()
          if (filtersOn && ch < 8) x = hi.run(lo.run(lp.run(x, ch), ch), ch)
          x *= g
          if (float) out.putFloat(x.coerceIn(-1.0, 1.0).toFloat()) else out.putShort(x.coerceIn(-32768.0, 32767.0).toInt().toShort())
        }
      }
      // Odd leftover bytes (shouldn't happen): pass them on.
      while (inputBuffer.hasRemaining()) out.put(inputBuffer.get())
    }
    current = target
    out.flip()
  }

  override fun onFlush(streamMetadata: AudioProcessor.StreamMetadata) {
    // A new song (or a jump): find out which one from the stream info.
    try {
      val uid = streamMetadata.periodUid
      val tl = streamMetadata.timeline
      if (uid != null && !tl.isEmpty) {
        val w = tl.getPeriodByUid(uid, period).windowIndex
        playingId = tl.getWindow(w, window).mediaItem.mediaId
        streamKnown = true
      }
    } catch (e: Exception) {
    }
    lp.reset()
    lo.reset()
    hi.reset()
  }

  override fun onReset() {
    current = gain
    applied = null
  }

  /** RBJ biquad, up to 8 channels. */
  private class Biquad {
    private var b0 = 1.0
    private var b1 = 0.0
    private var b2 = 0.0
    private var a1 = 0.0
    private var a2 = 0.0
    private val z = DoubleArray(32)

    fun reset() = z.fill(0.0)

    private fun set(nb0: Double, nb1: Double, nb2: Double, a0: Double, na1: Double, na2: Double) {
      b0 = nb0 / a0
      b1 = nb1 / a0
      b2 = nb2 / a0
      a1 = na1 / a0
      a2 = na2 / a0
    }

    fun lowpass(freq: Double, rate: Int) {
      val w = 2 * PI * minOf(freq, rate * 0.45) / rate
      val al = sin(w) / (2 * 0.7071)
      val cs = cos(w)
      set((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al)
    }

    fun shelf(freq: Double, db: Double, high: Boolean, rate: Int) {
      val a = 10.0.pow(db / 40)
      val w = 2 * PI * freq / rate
      val cs = cos(w)
      val al = sin(w) / 2 * sqrt(2.0)
      val sq = 2 * sqrt(a) * al
      if (!high) {
        set(a * (a + 1 - (a - 1) * cs + sq), 2 * a * (a - 1 - (a + 1) * cs), a * (a + 1 - (a - 1) * cs - sq), a + 1 + (a - 1) * cs + sq, -2 * (a - 1 + (a + 1) * cs), a + 1 + (a - 1) * cs - sq)
      } else {
        set(a * (a + 1 + (a - 1) * cs + sq), -2 * a * (a - 1 + (a + 1) * cs), a * (a + 1 + (a - 1) * cs - sq), a + 1 - (a - 1) * cs + sq, 2 * (a - 1 - (a + 1) * cs), a + 1 - (a - 1) * cs - sq)
      }
    }

    fun run(x: Double, ch: Int): Double {
      val o = ch * 4
      val y = b0 * x + b1 * z[o] + b2 * z[o + 1] - a1 * z[o + 2] - a2 * z[o + 3]
      z[o + 1] = z[o]
      z[o] = x
      z[o + 3] = z[o + 2]
      z[o + 2] = y
      return y
    }
  }
}
