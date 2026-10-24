package app.aurora.mobile

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Transitions on the phone: the same maths as the desktop app
 * (src/lib/mixmath.ts), so a transition made on a PC plays the same here.
 * Times are ms; bStart/aEnd on A's timeline, bOffset on B's; volumes 0–1.
 * Effect lines: dampen 0…1, bass/treble 0.5 = unchanged.
 */
class Pt(val t: Double, val g: Double)

class Fx(val damp: Double, val bass: Double, val treble: Double) {
  val neutral get() = damp < 0.002 && abs(bass) < 0.002 && abs(treble) < 0.002

  companion object {
    val NONE = Fx(0.0, 0.0, 0.0)
  }
}

class Mix(
  val bStart: Double,
  val aEnd: Double,
  val bOffset: Double,
  val fadeOut: Double,
  val fadeIn: Double,
  val aGain: Double,
  val bGain: Double,
  val smooth: Boolean,
  val aPoints: List<Pt>?,
  val bPoints: List<Pt>?,
  val aFx: Map<String, List<Pt>>,
  val bFx: Map<String, List<Pt>>,
) {
  private fun between(p: Pt, q: Pt, t: Double): Double {
    val x = if (q.t > p.t) ((t - p.t) / (q.t - p.t)).coerceIn(0.0, 1.0) else 1.0
    if (!smooth) return p.g + (q.g - p.g) * x
    return if (q.g < p.g) q.g + (p.g - q.g) * cos(x * Math.PI / 2) else p.g + (q.g - p.g) * sin(x * Math.PI / 2)
  }

  private fun along(pts: List<Pt>, t: Double): Double {
    if (pts.isEmpty()) return 1.0
    if (t <= pts[0].t) return pts[0].g
    for (i in 1 until pts.size) if (t <= pts[i].t) return between(pts[i - 1], pts[i], t)
    return pts.last().g
  }

  private fun shape(x: Double): Double {
    val v = x.coerceIn(0.0, 1.0)
    return if (smooth) sin(v * Math.PI / 2) else v
  }

  /** Volume of A at A-time t. */
  fun gainA(t: Double): Double {
    if (t >= aEnd) return 0.0
    aPoints?.let { if (it.isNotEmpty()) return along(it, t).coerceIn(0.0, 1.0) }
    var g = if (t < bStart) 1.0 else 1 + (aGain - 1) * min(1.0, (t - bStart) / 400)
    if (fadeOut > 0 && t > aEnd - fadeOut) g *= shape((aEnd - t) / fadeOut)
    return g
  }

  /** Volume of B at A-time t. */
  fun gainB(t: Double): Double {
    if (t < bStart) return 0.0
    bPoints?.let { pts ->
      if (pts.isNotEmpty()) {
        val r = t - bStart
        val last = pts.last()
        val g = if (r <= last.t) along(pts, r) else last.g + (1 - last.g) * min(1.0, (r - last.t) / SETTLE)
        return g.coerceIn(0.0, 1.0)
      }
    }
    val inG = if (fadeIn > 0) shape((t - bStart) / fadeIn) else 1.0
    val end = max(aEnd, bStart + fadeIn)
    val level = if (t <= end) bGain else bGain + (1 - bGain) * min(1.0, (t - end) / SETTLE)
    return inG * level
  }

  private fun toFx(name: String, v: Double) = if (name == "damp") v else (v - 0.5) * 2

  fun fxA(t: Double): Fx = Fx(
    aFx["damp"]?.let { toFx("damp", along(it, t)) } ?: 0.0,
    aFx["bass"]?.let { toFx("bass", along(it, t)) } ?: 0.0,
    aFx["treble"]?.let { toFx("treble", along(it, t)) } ?: 0.0,
  )

  fun fxB(t: Double): Fx {
    val r = t - bStart
    fun one(name: String, rest: Double): Double {
      val pts = bFx[name] ?: return 0.0
      if (pts.isEmpty()) return 0.0
      val last = pts.last()
      val v = if (r <= last.t) along(pts, r) else last.g + (rest - last.g) * min(1.0, (r - last.t) / SETTLE)
      return toFx(name, v)
    }
    return Fx(one("damp", 0.0), one("bass", 0.5), one("treble", 0.5))
  }

  val hasFx get() = aFx.isNotEmpty() || bFx.isNotEmpty()

  /** When the transition is completely over, on A's timeline. */
  fun end(): Double {
    var e = aEnd
    bPoints?.lastOrNull()?.let { e = max(e, bStart + it.t + if (it.g < 1) SETTLE else 0.0) }
      ?: run { e = max(aEnd, bStart + fadeIn) + if (bGain < 1) SETTLE else 0.0 }
    for ((name, pts) in bFx) {
      val last = pts.lastOrNull() ?: continue
      val rest = if (name == "damp") 0.0 else 0.5
      e = max(e, bStart + last.t + if (abs(last.g - rest) > 0.001) SETTLE else 0.0)
    }
    return e
  }

  companion object {
    const val SETTLE = 1500.0

    private fun pts(a: JSONArray?): List<Pt>? = a?.let { arr ->
      (0 until arr.length()).mapNotNull { i -> arr.optJSONObject(i)?.let { Pt(it.optDouble("t", 0.0), it.optDouble("g", 1.0)) } }.sortedBy { it.t }
    }

    private fun fx(o: JSONObject?): Map<String, List<Pt>> {
      val out = HashMap<String, List<Pt>>()
      if (o == null) return out
      for (n in listOf("damp", "bass", "treble")) pts(o.optJSONArray(n))?.takeIf { it.isNotEmpty() }?.let { out[n] = it }
      return out
    }

    fun parse(o: JSONObject, aDur: Double, bDur: Double): Mix {
      val aEnd = o.optDouble("aEnd", aDur).coerceIn(1000.0, if (aDur > 0) aDur else Double.MAX_VALUE)
      return Mix(
        bStart = o.optDouble("bStart", aEnd).coerceIn(0.0, aEnd),
        aEnd = aEnd,
        bOffset = o.optDouble("bOffset", 0.0).coerceIn(0.0, max(0.0, bDur - 1000)),
        fadeOut = o.optDouble("fadeOut", 0.0),
        fadeIn = o.optDouble("fadeIn", 0.0),
        aGain = o.optDouble("aGain", 1.0).coerceIn(0.0, 1.0),
        bGain = o.optDouble("bGain", 1.0).coerceIn(0.0, 1.0),
        smooth = o.optString("curve", "smooth") != "linear",
        aPoints = pts(o.optJSONArray("aPoints")),
        bPoints = pts(o.optJSONArray("bPoints")),
        aFx = fx(o.optJSONObject("aFx")),
        bFx = fx(o.optJSONObject("bFx")),
      )
    }

    /** The "Smooth" preset: skip silence at both ends, equal-power crossfade. */
    fun smooth(aDur: Double, bDur: Double, len: Double, a: AudioScan.Bounds?, b: AudioScan.Bounds?): Mix {
      val aEnd = a?.endMs ?: aDur
      val bOffset = b?.leadMs ?: 0.0
      val l = max(0.0, minOf(len, aEnd / 3, (bDur - bOffset) / 3))
      return Mix(aEnd - l, aEnd, bOffset, l, l, 1.0, 1.0, true, null, null, emptyMap(), emptyMap())
    }
  }
}

/** Reads the transitions the app saved for the active profile (p-<profile>-transitions.json). */
object Transitions {
  private var file: File? = null
  private var stamp = -1L
  private var data: JSONObject? = null
  /** Bumped when the app says something changed. */
  @Volatile
  var version = 0
    private set
  private val bounds = ConcurrentHashMap<String, AudioScan.Bounds>()
  private val pending = ConcurrentHashMap.newKeySet<String>()
  private val io = Executors.newSingleThreadExecutor()

  fun changed() {
    version++
    stamp = -1
  }

  @Synchronized
  private fun load(context: Context): JSONObject? {
    val dir = context.dataDir
    val profile = try {
      JSONObject(File(dir, "profiles.json").readText()).optString("active")
    } catch (e: Exception) {
      ""
    }
    val f = File(dir, "p-$profile-transitions.json")
    if (f != file || f.lastModified() != stamp) {
      file = f
      stamp = f.lastModified()
      data = try {
        if (f.isFile) JSONObject(f.readText()) else null
      } catch (e: Exception) {
        null
      }
    }
    return data
  }

  /**
   * How to go from song A into song B, or null for one after the other.
   * `onReady` is called (on a background thread) when a better plan is ready (Smooth after analysing the songs).
   */
  fun plan(context: Context, aId: String, aPath: String, aDur: Double, bId: String, bPath: String, bDur: Double, onReady: () -> Unit): Mix? {
    val d = load(context) ?: return null
    val pair = d.optJSONObject("pairs")?.optJSONObject("$aId>$bId")
    val mode = pair?.optString("mode") ?: d.optString("mode", "none")
    return when (mode) {
      "custom" -> pair?.optJSONObject("mix")?.let { Mix.parse(it, aDur, bDur) }
      "smooth" -> {
        val ba = bounds[aPath]
        val bb = bounds[bPath]
        if (ba == null || bb == null) analyse(listOf(aPath to aDur, bPath to bDur), onReady)
        Mix.smooth(aDur, bDur, d.optDouble("smoothMs", 6000.0), ba, bb)
      }
      else -> null
    }
  }

  private fun analyse(songs: List<Pair<String, Double>>, onReady: () -> Unit) {
    for ((path, dur) in songs) {
      if (bounds.containsKey(path) || !pending.add(path)) continue
      io.execute {
        try {
          AudioScan.bounds(path, dur)?.let { bounds[path] = it }
        } catch (e: Exception) {
        } finally {
          pending.remove(path)
        }
        onReady()
      }
    }
  }
}
