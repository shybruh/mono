package app.mono.player

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.DocumentsContract
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import org.json.JSONObject
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  /** Audio files on Android 13+, external storage before that. */
  private val audioPermission =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.READ_MEDIA_AUDIO
    else Manifest.permission.READ_EXTERNAL_STORAGE

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Keep the page clear of the status bar, the gesture bar and the keyboard;
    // the window background shows behind the bars.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }

    // Music access, and (Android 13+) the playback notification.
    val wanted = buildList {
      add(audioPermission)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
    }.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
    if (wanted.isNotEmpty()) ActivityCompat.requestPermissions(this, wanted.toTypedArray(), REQUEST_PERMISSIONS)
  }

  /** Android's own folder picker; the chosen folder goes back to the page as a path. */
  private val folderPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
    val path = uri?.let { treePath(it) } ?: ""
    webView?.evaluateJavascript(
      "window.dispatchEvent(new CustomEvent('mono:folder',{detail:${JSONObject.quote(path)}}))",
      null,
    )
  }

  /** `window.MonoFolders` in the page. */
  inner class FolderBridge {
    @JavascriptInterface
    fun pick() = runOnUiThread { folderPicker.launch(null) }

    /**
     * Whether Mono may change music files it didn't create (tags, covers,
     * lyrics files). Android 11+ only allows that with "All files access".
     */
    @JavascriptInterface
    fun canEdit(): Boolean =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Environment.isExternalStorageManager()
      else ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

    /** Opens the system page that grants it. */
    @JavascriptInterface
    fun askEdit() = runOnUiThread {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")))
      } else {
        ActivityCompat.requestPermissions(this@MainActivity, arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQUEST_PERMISSIONS)
      }
    }
  }

  /**
   * The file-system path behind a picked folder. Mono reads folders directly,
   * which works for the phone's storage and SD cards (with music access) but
   * not for cloud providers, so those give no path.
   */
  private fun treePath(uri: Uri): String? {
    val id = try {
      DocumentsContract.getTreeDocumentId(uri)
    } catch (_: Exception) {
      return null
    }
    return when (uri.authority) {
      "com.android.externalstorage.documents" -> {
        val volume = id.substringBefore(':')
        val rel = id.substringAfter(':', "")
        val base =
          if (volume.equals("primary", ignoreCase = true)) Environment.getExternalStorageDirectory().path
          else "/storage/$volume"
        if (rel.isEmpty()) base else "$base/$rel"
      }
      "com.android.providers.downloads.documents" -> when {
        id.startsWith("raw:") -> id.removePrefix("raw:")
        id == "downloads" -> Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS).path
        else -> null
      }
      else -> null
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    NowPlaying.webView = webView
    webView.addJavascriptInterface(MediaBridge(applicationContext), "MonoAndroid")
    webView.addJavascriptInterface(FolderBridge(), "MonoFolders")
  }

  override fun onDestroy() {
    if (NowPlaying.webView === webView) NowPlaying.webView = null
    super.onDestroy()
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    val i = permissions.indexOf(audioPermission)
    if (requestCode == REQUEST_PERMISSIONS && i >= 0 && grantResults.getOrNull(i) == PackageManager.PERMISSION_GRANTED) {
      // The library was scanned before access was granted; tell the page to scan again.
      webView?.evaluateJavascript("window.dispatchEvent(new Event('mono:storage'))", null)
    }
  }

  private companion object {
    const val REQUEST_PERMISSIONS = 1
  }
}
