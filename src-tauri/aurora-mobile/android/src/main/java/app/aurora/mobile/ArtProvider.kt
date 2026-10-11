package app.aurora.mobile

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileNotFoundException

/**
 * Serves the cover thumbnails Aurora keeps in its "covers" folder, so Android
 * Auto and the lock screen (other processes) can show album art.
 * Read-only, and nothing outside that folder.
 */
class ArtProvider : ContentProvider() {
  override fun onCreate() = true

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    val ctx = context ?: throw FileNotFoundException()
    val name = uri.lastPathSegment ?: throw FileNotFoundException()
    if (name.contains('/') || name.startsWith(".") || !name.endsWith(".jpg")) throw FileNotFoundException()
    val file = File(File(ctx.dataDir, "covers"), name)
    if (!file.isFile) throw FileNotFoundException()
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
  }

  override fun getType(uri: Uri) = "image/jpeg"
  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}
