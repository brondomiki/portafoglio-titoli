@file:androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])

package it.brondomiki.portafoglio

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import java.util.concurrent.Callable
import java.util.concurrent.Executors

/**
 * Servizio audio visto da Android Auto.
 * Schede: "Portafoglio" (riepilogo + un elemento per titolo) e "Suggeriti".
 * Toccando un elemento si ascolta la sua valutazione; avanti/indietro (anche dal volante) passa al titolo successivo.
 */
class AutoService : MediaLibraryService() {
    private lateinit var player: ExoPlayer
    private var session: MediaLibrarySession? = null
    private val exec = MoreExecutors.listeningDecorator(Executors.newCachedThreadPool())
    private val main = Handler(Looper.getMainLooper())
    private var lastPortfolioSize = 0
    private var lastSuggestionsSize = 0

    private val refreshLoop = object : Runnable {
        override fun run() {
            exec.execute {
                val changed = Store.refresh(this@AutoService)
                if (changed) main.post { notifyLists() }
            }
            main.postDelayed(this, 60_000)
        }
    }

    override fun onCreate() {
        super.onCreate()
        Speaker.init(this)
        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(TtsDataSource.Factory(this)))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(),
                true
            )
            .setHandleAudioBecomingNoisy(true)
            .build()
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        session = MediaLibrarySession.Builder(this, player, Callback()).setSessionActivity(open).build()
        main.post(refreshLoop)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        if (!player.playWhenReady || player.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        session?.run { player.release(); release() }
        session = null
        super.onDestroy()
    }

    private fun notifyLists() {
        val s = session ?: return
        val p = Store.portfolio().size
        val g = Store.suggestions().size
        s.notifyChildrenChanged(PORTFOLIO, maxOf(p, lastPortfolioSize), null)
        s.notifyChildrenChanged(SUGGESTIONS, maxOf(g, lastSuggestionsSize), null)
        lastPortfolioSize = p; lastSuggestionsSize = g
    }

    // ---------- elementi ----------
    private fun folder(id: String, title: String, subtitle: String? = null): MediaItem =
        MediaItem.Builder()
            .setMediaId(id)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(title)
                    .setSubtitle(subtitle)
                    .setIsBrowsable(true)
                    .setIsPlayable(false)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                    .build()
            ).build()

    private fun Entry.item(): MediaItem =
        MediaItem.Builder()
            .setMediaId(id)
            .setUri(Uri.parse("tts://speech?id=" + Uri.encode(id)))
            .setMimeType(MimeTypes.AUDIO_WAV)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(title)
                    .setDisplayTitle(title)
                    .setSubtitle(subtitle)
                    .setArtist(subtitle)
                    .setAlbumTitle("Portafoglio")
                    .setArtworkUri(Uri.parse("android.resource://$packageName/drawable/$art"))
                    .setIsBrowsable(false)
                    .setIsPlayable(true)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_PODCAST_EPISODE)
                    .build()
            ).build()

    private fun resolve(items: List<MediaItem>): List<MediaItem> =
        items.map { mi -> Store.find(mi.mediaId)?.item() ?: mi }

    private fun <T> async(block: () -> T): ListenableFuture<T> = exec.submit(Callable { block() })

    private inner class Callback : MediaLibrarySession.Callback {
        override fun onGetLibraryRoot(
            session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?
        ): ListenableFuture<LibraryResult<MediaItem>> {
            // elenco (non griglia) per voci con testo
            val extras = Bundle().apply {
                putInt("android.media.browse.CONTENT_STYLE_BROWSABLE_HINT", 1)
                putInt("android.media.browse.CONTENT_STYLE_PLAYABLE_HINT", 1)
            }
            return Futures.immediateFuture(
                LibraryResult.ofItem(folder(ROOT, "Portafoglio"), LibraryParams.Builder().setExtras(extras).build())
            )
        }

        override fun onGetChildren(
            session: MediaLibrarySession, browser: MediaSession.ControllerInfo,
            parentId: String, page: Int, pageSize: Int, params: LibraryParams?
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = async {
            Store.ensureFresh(this@AutoService)
            val list = when (parentId) {
                ROOT -> listOf(folder(PORTFOLIO, "Portafoglio"), folder(SUGGESTIONS, "Suggeriti"))
                PORTFOLIO -> Store.portfolio().map { it.item() }.also { lastPortfolioSize = it.size }
                SUGGESTIONS -> Store.suggestions().map { it.item() }.also { lastSuggestionsSize = it.size }
                else -> emptyList()
            }
            LibraryResult.ofItemList(ImmutableList.copyOf(list), params)
        }

        override fun onGetItem(
            session: MediaLibrarySession, browser: MediaSession.ControllerInfo, mediaId: String
        ): ListenableFuture<LibraryResult<MediaItem>> = async {
            Store.ensureFresh(this@AutoService)
            val item = when (mediaId) {
                ROOT -> folder(ROOT, "Portafoglio")
                PORTFOLIO -> folder(PORTFOLIO, "Portafoglio")
                SUGGESTIONS -> folder(SUGGESTIONS, "Suggeriti")
                else -> (Store.find(mediaId) ?: Store.portfolio().first()).item()
            }
            LibraryResult.ofItem(item, null)
        }

        override fun onAddMediaItems(
            mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>
        ): ListenableFuture<MutableList<MediaItem>> = async {
            Store.ensureFresh(this@AutoService)
            resolve(mediaItems).toMutableList()
        }

        // toccando un titolo si accoda tutto l'elenco: avanti/indietro passa ai titoli vicini
        override fun onSetMediaItems(
            mediaSession: MediaSession, controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> = async {
            Store.ensureFresh(this@AutoService)
            val single = mediaItems.singleOrNull()?.mediaId
            val folder = single?.let { Store.folderOf(it) }
            if (single != null && folder != null) {
                val idx = folder.indexOfFirst { it.id == single }.coerceAtLeast(0)
                MediaSession.MediaItemsWithStartPosition(folder.map { it.item() }, idx, C.TIME_UNSET)
            } else {
                MediaSession.MediaItemsWithStartPosition(resolve(mediaItems), startIndex, startPositionMs)
            }
        }

        // tasto play senza aver scelto nulla: parte il riepilogo
        override fun onPlaybackResumption(
            mediaSession: MediaSession, controller: MediaSession.ControllerInfo
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> = async {
            Store.ensureFresh(this@AutoService)
            MediaSession.MediaItemsWithStartPosition(Store.portfolio().map { it.item() }, 0, C.TIME_UNSET)
        }
    }

    companion object {
        const val ROOT = "root"
        const val PORTFOLIO = "portafoglio"
        const val SUGGESTIONS = "suggeriti"
    }
}
