package app.aurora.mobile

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.media3.exoplayer.ExoPlayer
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject

/**
 * Audio outputs (phone speaker, wired, Bluetooth, USB, HDMI) and the user's
 * choice. Android gives devices a new id every time they connect, so the
 * choice is remembered by type + name ("8|Pixel Buds").
 * ExoPlayer plays to the preferred device while it's connected and falls
 * back to Android's normal routing when it isn't. In the car, Android Auto
 * always takes the sound.
 */
object Outputs {
  private const val PREFS = "aurora-output"
  private var callback: AudioDeviceCallback? = null
  private val listeners = mutableListOf<() -> Unit>()

  private fun kind(type: Int): String? = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, 26 /* BLE_HEADSET */, 27 /* BLE_SPEAKER */, 30 /* BLE_BROADCAST */ -> "bluetooth"
    AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_ACCESSORY -> "usb"
    AudioDeviceInfo.TYPE_HDMI, AudioDeviceInfo.TYPE_HDMI_ARC, 29 /* HDMI_EARC */ -> "hdmi"
    AudioDeviceInfo.TYPE_DOCK, AudioDeviceInfo.TYPE_LINE_ANALOG, AudioDeviceInfo.TYPE_LINE_DIGITAL -> "other"
    else -> null // earpiece, phone-call Bluetooth (SCO), telephony, …: not for music
  }

  private fun label(d: AudioDeviceInfo, kind: String): String {
    val name = d.productName?.toString()?.trim().orEmpty()
    val model = Build.MODEL.orEmpty()
    return when {
      kind == "speaker" -> "Phone speaker"
      kind == "wired" -> "Wired headphones"
      name.isNotEmpty() && !name.equals(model, ignoreCase = true) -> name
      kind == "bluetooth" -> "Bluetooth device"
      kind == "usb" -> "USB audio"
      kind == "hdmi" -> "HDMI"
      else -> "Line out"
    }
  }

  private fun key(d: AudioDeviceInfo) = "${d.type}|${d.productName}"

  private fun devices(context: Context): List<AudioDeviceInfo> {
    val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    return am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
      .filter { it.isSink && kind(it.type) != null }
      .distinctBy { key(it) }
  }

  fun list(context: Context): JSArray {
    val arr = JSArray()
    for (d in devices(context)) {
      val k = kind(d.type) ?: continue
      arr.put(JSObject().apply {
        put("id", key(d))
        put("label", label(d, k))
        put("kind", k)
      })
    }
    return arr
  }

  fun chosen(context: Context): String? =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("id", null)

  /** Remembers the choice (null = Android decides) and applies it to the player. */
  fun choose(context: Context, id: String?) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("id", id).apply()
    PlaybackService.current?.let { apply(context, it.player) }
  }

  /** Points the player at the chosen device if it's connected (call on the main thread). */
  fun apply(context: Context, player: ExoPlayer) {
    val id = chosen(context)
    val device = if (id == null) null else devices(context).firstOrNull { key(it) == id }
    player.setPreferredAudioDevice(device)
  }

  /** Re-applies the choice when devices come and go, and tells listeners. */
  @Synchronized
  fun watch(context: Context, onChange: () -> Unit) {
    listeners.add(onChange)
    if (callback != null) return
    val app = context.applicationContext
    val am = app.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val cb = object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = changed()
      override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = changed()
      private fun changed() {
        PlaybackService.current?.let { apply(app, it.player) }
        synchronized(this@Outputs) { listeners.toList() }.forEach { it() }
      }
    }
    callback = cb
    am.registerAudioDeviceCallback(cb, Handler(Looper.getMainLooper()))
  }
}
