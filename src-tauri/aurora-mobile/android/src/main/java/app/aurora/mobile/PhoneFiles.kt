package app.aurora.mobile

import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import java.io.File

/**
 * Files outside Aurora's own folder. Android doesn't hand apps plain paths
 * for things picked in its screens, so these turn what the user picked into
 * something Aurora's core (which works with ordinary files) can use.
 */
object PhoneFiles {
  /**
   * Folders that hold music, from Android's own music index (needs the
   * "music and audio" permission). With that permission Aurora can read
   * those files directly, so its normal library scanner handles them.
   */
  fun musicFolders(context: Context): JSArray {
    val counts = HashMap<String, Int>()
    @Suppress("DEPRECATION")
    val column = MediaStore.Audio.Media.DATA
    context.contentResolver.query(
      MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
      arrayOf(column),
      "${MediaStore.Audio.Media.IS_MUSIC} != 0",
      null,
      null,
    )?.use { c ->
      val i = c.getColumnIndex(column)
      while (i >= 0 && c.moveToNext()) {
        val path = c.getString(i) ?: continue
        val parent = File(path).parent ?: continue
        counts[parent] = (counts[parent] ?: 0) + 1
      }
    }
    // Group sub-folders under their top music folder (e.g. Music/Artist/Album → Music).
    val roots = HashMap<String, Int>()
    val sorted = counts.keys.sortedBy { it.length }
    for (dir in sorted) {
      val root = roots.keys.firstOrNull { dir == it || dir.startsWith("$it/") } ?: topFolder(dir)
      roots[root] = (roots[root] ?: 0) + (counts[dir] ?: 0)
    }
    val out = JSArray()
    for ((path, n) in roots.entries.sortedByDescending { it.value }) {
      out.put(JSObject().apply {
        put("path", path)
        put("name", path.removePrefix("/storage/emulated/0/").ifEmpty { "Phone storage" })
        put("count", n)
      })
    }
    return out
  }

  /** "/storage/emulated/0/Music/Artist/Album" → "/storage/emulated/0/Music". */
  private fun topFolder(dir: String): String {
    val parts = dir.split('/')
    // /storage/emulated/0/<top>  or  /storage/XXXX-XXXX/<top> (SD card)
    val depth = if (dir.startsWith("/storage/emulated/")) 5 else 4
    return if (parts.size > depth) parts.take(depth).joinToString("/") else dir
  }

  /** Copies a picked image into Aurora's cache and returns its path. */
  fun copyImage(context: Context, uri: Uri): String {
    val dir = context.cacheDir
    dir.listFiles { f -> f.name.startsWith("picked-") }?.forEach { it.delete() }
    val mime = context.contentResolver.getType(uri)
    val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime ?: "") ?: "jpg"
    val out = File(dir, "picked-${System.currentTimeMillis()}.$ext")
    context.contentResolver.openInputStream(uri)?.use { input ->
      out.outputStream().use { input.copyTo(it) }
    } ?: throw IllegalStateException("Couldn't read that picture.")
    return out.absolutePath
  }

  /** An open file descriptor for a picked document; Aurora's core takes it over. */
  fun descriptor(context: Context, uri: Uri, write: Boolean): Int {
    val resolver = context.contentResolver
    val pfd = if (write) {
      // "wt" truncates; a few providers only know "w".
      try {
        resolver.openFileDescriptor(uri, "wt")
      } catch (e: Exception) {
        resolver.openFileDescriptor(uri, "w")
      }
    } else {
      resolver.openFileDescriptor(uri, "r")
    }
    return pfd?.detachFd() ?: throw IllegalStateException("Couldn't open that file.")
  }
}
