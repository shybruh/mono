package app.mono.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.MediaMetadataRetriever
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.Process
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.ContextCompat
import java.io.File

/**
 * What's playing, as last reported by the page, and the way back to it.
 * The audio itself runs in the Rust engine in this process; the page drives
 * it, so the system's buttons are handed to the page as `mono:media` events.
 */
object NowPlaying {
  @Volatile var path = ""
  @Volatile var title = ""
  @Volatile var artist = ""
  @Volatile var album = ""
  @Volatile var playing = false
  @Volatile var durationMs = 0L
  @Volatile var posMs = 0L
  @Volatile var art: Bitmap? = null
  @Volatile var webView: WebView? = null

  fun send(action: String, value: Long = 0) {
    val wv = webView ?: return
    wv.post {
      wv.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('mono:media',{detail:{action:'$action',value:$value}}))",
        null,
      )
    }
  }
}

/** `window.MonoAndroid` in the page. */
class MediaBridge(private val context: Context) {
  @JavascriptInterface
  fun update(path: String, title: String, artist: String, album: String, playing: Boolean, durationMs: Double, posMs: Double) {
    if (path != NowPlaying.path) {
      NowPlaying.path = path
      NowPlaying.art = loadArt(path)
    }
    NowPlaying.title = title
    NowPlaying.artist = artist
    NowPlaying.album = album
    NowPlaying.playing = playing
    NowPlaying.durationMs = durationMs.toLong()
    NowPlaying.posMs = posMs.toLong()

    val intent = Intent(context, PlaybackService::class.java)
    try {
      if (PlaybackService.running) context.startService(intent)
      else if (playing) ContextCompat.startForegroundService(context, intent)
    } catch (_: Exception) {
      // Android refuses to start it from the background; the next update from the foreground will.
    }
  }

  /** Embedded cover art, else a cover image next to the file. */
  private fun loadArt(path: String): Bitmap? {
    val bytes = try {
      MediaMetadataRetriever().run {
        try {
          setDataSource(path)
          embeddedPicture
        } finally {
          release()
        }
      }
    } catch (_: Exception) {
      null
    }
    if (bytes != null) return scaled(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
    val dir = File(path).parentFile ?: return null
    val names = listOf("cover.jpg", "cover.png", "folder.jpg", "folder.png", "front.jpg", "front.png")
    val file = dir.listFiles()?.firstOrNull { f -> names.any { it.equals(f.name, ignoreCase = true) } } ?: return null
    return scaled(BitmapFactory.decodeFile(file.path))
  }

  private fun scaled(b: Bitmap?): Bitmap? {
    if (b == null) return null
    val max = 512
    if (b.width <= max && b.height <= max) return b
    val k = max.toFloat() / maxOf(b.width, b.height)
    return Bitmap.createScaledBitmap(b, (b.width * k).toInt(), (b.height * k).toInt(), true)
  }
}

/**
 * Keeps Mono alive while it plays in the background, and owns the media
 * session behind the notification, the lock screen and headset buttons.
 */
class PlaybackService : Service() {
  companion object {
    @Volatile var running = false
    private const val CHANNEL = "playback"
    private const val NOTIFICATION = 1
    private const val ACTION_TOGGLE = "app.mono.player.TOGGLE"
    private const val ACTION_NEXT = "app.mono.player.NEXT"
    private const val ACTION_PREV = "app.mono.player.PREV"
  }

  private lateinit var session: MediaSession
  private lateinit var audio: AudioManager
  private var focus: AudioFocusRequest? = null
  private var resumeOnFocus = false
  private var wakeLock: PowerManager.WakeLock? = null

  /** Headphones unplugged or Bluetooth dropped: pause, like every player. */
  private val noisy = object : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
      if (NowPlaying.playing) NowPlaying.send("pause")
    }
  }

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS -> {
        resumeOnFocus = false
        NowPlaying.send("pause")
      }
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
        // A call or a voice prompt: pause, and carry on once it's over.
        resumeOnFocus = NowPlaying.playing
        NowPlaying.send("pause")
      }
      AudioManager.AUDIOFOCUS_GAIN -> {
        if (resumeOnFocus) NowPlaying.send("play")
        resumeOnFocus = false
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    running = true
    audio = getSystemService(AUDIO_SERVICE) as AudioManager
    val nm = getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL, "Playback", NotificationManager.IMPORTANCE_LOW).apply {
        setShowBadge(false)
      },
    )
    session = MediaSession(this, "mono").apply {
      setCallback(object : MediaSession.Callback() {
        override fun onPlay() = NowPlaying.send("play")
        override fun onPause() = NowPlaying.send("pause")
        override fun onStop() = NowPlaying.send("pause")
        override fun onSkipToNext() = NowPlaying.send("next")
        override fun onSkipToPrevious() = NowPlaying.send("prev")
        override fun onSeekTo(pos: Long) = NowPlaying.send("seek", pos)
      })
      setSessionActivity(openApp())
      isActive = true
    }
    ContextCompat.registerReceiver(
      this,
      noisy,
      IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_TOGGLE -> NowPlaying.send(if (NowPlaying.playing) "pause" else "play")
      ACTION_NEXT -> NowPlaying.send("next")
      ACTION_PREV -> NowPlaying.send("prev")
    }
    refresh()
    return START_NOT_STICKY
  }

  /** Swiping Mono away from recents closes it, music included. */
  override fun onTaskRemoved(rootIntent: Intent?) {
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
    Process.killProcess(Process.myPid())
  }

  override fun onDestroy() {
    running = false
    try {
      unregisterReceiver(noisy)
    } catch (_: Exception) {
    }
    focus?.let { audio.abandonAudioFocusRequest(it) }
    wakeLock?.let { if (it.isHeld) it.release() }
    session.release()
    super.onDestroy()
  }

  private fun refresh() {
    val np = NowPlaying
    session.setMetadata(
      MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_TITLE, np.title)
        .putString(MediaMetadata.METADATA_KEY_ARTIST, np.artist)
        .putString(MediaMetadata.METADATA_KEY_ALBUM, np.album)
        .putLong(MediaMetadata.METADATA_KEY_DURATION, np.durationMs)
        .putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, np.art)
        .build(),
    )
    session.setPlaybackState(
      PlaybackState.Builder()
        .setActions(
          PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or
            PlaybackState.ACTION_SEEK_TO or PlaybackState.ACTION_STOP,
        )
        .setState(
          if (np.playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
          np.posMs,
          if (np.playing) 1f else 0f,
        )
        .build(),
    )

    val notification = notification()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
      } else {
        startForeground(NOTIFICATION, notification)
      }
    } catch (_: Exception) {
      // Not allowed from the background right now; the notification still updates below.
    }

    if (np.playing) {
      takeFocus()
      if (wakeLock == null) {
        wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
          .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mono:playback")
      }
      wakeLock?.let { if (!it.isHeld) it.acquire() }
    } else {
      wakeLock?.let { if (it.isHeld) it.release() }
      // Paused: the notification stays, but can be swiped away and Android may stop the app.
      stopForeground(STOP_FOREGROUND_DETACH)
      getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification)
    }
  }

  private fun takeFocus() {
    if (focus != null) return
    val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
          .build(),
      )
      .setOnAudioFocusChangeListener(focusListener)
      .build()
    if (audio.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) focus = req
  }

  private fun notification(): Notification {
    val np = NowPlaying
    fun action(icon: Int, title: String, act: String) =
      Notification.Action.Builder(
        Icon.createWithResource(this, icon),
        title,
        PendingIntent.getService(
          this,
          act.hashCode(),
          Intent(this, PlaybackService::class.java).setAction(act),
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        ),
      ).build()

    return Notification.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_mono)
      .setContentTitle(np.title)
      .setContentText(np.artist)
      .setLargeIcon(np.art)
      .setContentIntent(openApp())
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setOngoing(np.playing)
      .setShowWhen(false)
      .addAction(action(android.R.drawable.ic_media_previous, "Previous", ACTION_PREV))
      .addAction(
        if (np.playing) action(android.R.drawable.ic_media_pause, "Pause", ACTION_TOGGLE)
        else action(android.R.drawable.ic_media_play, "Play", ACTION_TOGGLE),
      )
      .addAction(action(android.R.drawable.ic_media_next, "Next", ACTION_NEXT))
      .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
      .build()
  }

  private fun openApp(): PendingIntent =
    PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
}
