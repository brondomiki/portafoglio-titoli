package it.brondomiki.portafoglio

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.io.File
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Sintesi vocale del telefono (italiano) trasformata in file audio, così passa dall'audio dell'auto. */
object Speaker {
    @Volatile private var tts: TextToSpeech? = null
    @Volatile private var ready = CountDownLatch(1)
    private val pending = ConcurrentHashMap<String, CountDownLatch>()

    /** Va chiamato dal thread principale (onCreate del servizio o dell'activity). */
    @Synchronized
    fun init(ctx: Context) {
        if (tts != null) return
        val app = ctx.applicationContext
        ready = CountDownLatch(1)
        lateinit var engine: TextToSpeech
        engine = TextToSpeech(app) { status ->
            if (status == TextToSpeech.SUCCESS) {
                val r = engine.setLanguage(Locale.ITALIAN)
                if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) engine.setLanguage(Locale("it", "IT"))
                engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {}
                    override fun onDone(utteranceId: String?) { utteranceId?.let { pending.remove(it)?.countDown() } }
                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) { utteranceId?.let { pending.remove(it)?.countDown() } }
                    override fun onError(utteranceId: String?, errorCode: Int) { utteranceId?.let { pending.remove(it)?.countDown() } }
                })
            }
            ready.countDown()
        }
        tts = engine
        // pulizia dei file audio vecchi
        app.cacheDir.listFiles { f -> f.name.startsWith("tts_") && System.currentTimeMillis() - f.lastModified() > 6 * 3600_000 }?.forEach { it.delete() }
    }

    fun rate(ctx: Context): Float = ctx.getSharedPreferences("cfg", Context.MODE_PRIVATE).getFloat("rate", 1.0f)

    /** Crea (o riusa) il file WAV con il testo letto. Bloccante: da usare fuori dal thread principale. */
    fun synthesizeBlocking(ctx: Context, text: String): File {
        val engine = tts ?: throw IllegalStateException("Sintesi vocale non inizializzata")
        ready.await(10, TimeUnit.SECONDS)
        val r = rate(ctx)
        val f = File(ctx.cacheDir, "tts_${(text + r).hashCode().toUInt()}.wav")
        if (f.exists() && f.length() > 1000) return f
        val id = UUID.randomUUID().toString()
        val latch = CountDownLatch(1)
        pending[id] = latch
        synchronized(this) {
            engine.setSpeechRate(r)
            engine.synthesizeToFile(text, Bundle(), f, id)
        }
        latch.await(45, TimeUnit.SECONDS)
        pending.remove(id)
        return f
    }
}
