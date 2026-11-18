package it.brondomiki.portafoglio

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** Indirizzo della web app e codice di collegamento, salvati sul telefono. */
class Config(ctx: Context) {
    private val prefs = ctx.applicationContext.getSharedPreferences("cfg", Context.MODE_PRIVATE)
    var url: String
        get() = prefs.getString("url", "") ?: ""
        set(v) = prefs.edit().putString("url", v.trim().trimEnd('/')).apply()
    var token: String
        get() = prefs.getString("token", "") ?: ""
        set(v) = prefs.edit().putString("token", v.trim()).apply()
    val ok get() = url.startsWith("http") && token.length >= 20
}

/** Una voce dell'elenco su Android Auto: titolo, sottotitolo, testo da leggere, icona. */
data class Entry(
    val id: String,
    val title: String,
    val subtitle: String,
    val speech: String,
    val art: String
)

data class Snapshot(
    val summary: Entry,
    val holdings: List<Entry>,
    val suggestions: List<Entry>,
    val analysis: String,
    val fetchedAt: Long,
    val signature: String
)

/** Scarica il portafoglio da /api/car e lo tiene in memoria. */
object Store {
    @Volatile var snap: Snapshot? = null
        private set
    @Volatile var lastError: String? = null
        private set

    private fun artFor(v: Double) = when {
        v > 0.005 -> "art_up"
        v < -0.005 -> "art_down"
        else -> "art_flat"
    }

    fun fetch(cfg: Config): Snapshot {
        val u = URL("${cfg.url}/api/car?t=${URLEncoder.encode(cfg.token, "UTF-8")}")
        val c = (u.openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000
            readTimeout = 30000
            setRequestProperty("Accept", "application/json")
        }
        try {
            val code = c.responseCode
            val body = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: ""
            val j = if (body.isNotBlank()) JSONObject(body) else JSONObject()
            if (code !in 200..299) throw IllegalStateException(j.optString("error", "Errore $code"))

            val totals = j.optJSONObject("totals") ?: JSONObject()
            val sum = j.getJSONObject("summary")
            val summary = Entry(
                "summary",
                "Riepilogo · " + sum.optString("title"),
                sum.optString("subtitle"),
                sum.optString("speech"),
                artFor(totals.optDouble("day", 0.0))
            )
            val items = j.optJSONArray("items")
            val holdings = (0 until (items?.length() ?: 0)).map { i ->
                val it = items!!.getJSONObject(i)
                Entry("h:" + it.getString("symbol"), it.optString("title"), it.optString("subtitle"), it.optString("speech"), artFor(it.optDouble("dayEur", 0.0)))
            }
            val sug = j.optJSONArray("suggestions")
            val suggestions = (0 until (sug?.length() ?: 0)).map { i ->
                val it = sug!!.getJSONObject(i)
                Entry("s:" + it.getString("symbol"), it.optString("title"), it.optString("subtitle"), it.optString("speech"), "art_star")
            }
            val signature = (listOf(summary) + holdings + suggestions).joinToString("|") { it.title + it.subtitle }
            return Snapshot(summary, holdings, suggestions, j.optString("analysis"), System.currentTimeMillis(), signature)
        } finally {
            c.disconnect()
        }
    }

    /** Aggiorna i dati; restituisce true se sono cambiati. */
    @Synchronized
    fun refresh(ctx: Context): Boolean {
        val cfg = Config(ctx)
        if (!cfg.ok) { lastError = "App non collegata"; return false }
        return try {
            val old = snap?.signature
            snap = fetch(cfg)
            lastError = null
            old != snap?.signature
        } catch (e: Exception) {
            lastError = e.message ?: e.toString()
            false
        }
    }

    fun ensureFresh(ctx: Context, maxAgeMs: Long = 30_000) {
        val s = snap
        if (s == null || System.currentTimeMillis() - s.fetchedAt > maxAgeMs) refresh(ctx)
    }

    private fun notLinked(): Entry = Entry(
        "help",
        if (lastError == "App non collegata") "Apri Portafoglio Auto sul telefono" else "Dati non disponibili",
        lastError ?: "Collega l'app dal menu della web app",
        if (lastError == "App non collegata")
            "L'app non è ancora collegata al tuo portafoglio. Da fermo, apri la web app sul telefono, menu account, Collega Android Auto."
        else "Non riesco a scaricare i dati del portafoglio. ${lastError ?: ""}",
        "art_flat"
    )

    /** Elenco del portafoglio: riepilogo + titoli (ordinati per movimento di oggi). */
    fun portfolio(): List<Entry> = snap?.let { listOf(it.summary) + it.holdings } ?: listOf(notLinked())
    fun suggestions(): List<Entry> = snap?.suggestions?.takeIf { it.isNotEmpty() }
        ?: listOf(Entry("help-s", "Nessun suggerimento", "Analisi non ancora disponibile", "Non ci sono suggerimenti disponibili in questo momento.", "art_flat"))

    fun find(id: String): Entry? = (portfolio() + suggestions()).firstOrNull { it.id == id }
    fun folderOf(id: String): List<Entry>? = when {
        portfolio().any { it.id == id } -> portfolio()
        suggestions().any { it.id == id } -> suggestions()
        else -> null
    }

    fun textFor(id: String): String = find(id)?.speech?.takeIf { it.isNotBlank() } ?: notLinked().speech
}
