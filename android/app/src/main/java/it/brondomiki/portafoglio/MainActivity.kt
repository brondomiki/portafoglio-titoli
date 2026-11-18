package it.brondomiki.portafoglio

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** Schermata sul telefono: collegamento al portafoglio, prova e istruzioni per Android Auto. */
class MainActivity : Activity() {
    private lateinit var cfg: Config
    private lateinit var status: TextView
    private lateinit var url: EditText
    private lateinit var token: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cfg = Config(this)
        Speaker.init(this)
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        buildUi()
        handleLink(intent)
        if (cfg.ok) test()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        handleLink(intent)
    }

    // link "portafoglio-auto://setup?url=...&t=..." aperto dalla web app
    private fun handleLink(i: Intent?) {
        val d = i?.data ?: return
        if (d.scheme != "portafoglio-auto") return
        d.getQueryParameter("url")?.let { cfg.url = it }
        d.getQueryParameter("t")?.let { cfg.token = it }
        url.setText(cfg.url); token.setText(cfg.token)
        status.text = "Collegamento ricevuto, verifico…"
        test()
    }

    private fun test() {
        status.text = "Verifico il collegamento…"
        Thread {
            Store.refresh(this)
            val s = Store.snap
            val err = Store.lastError
            runOnUiThread {
                status.text = if (s != null && err == null)
                    "✅ Collegato\n\n${s.summary.title.removePrefix("Riepilogo · ")}\n${s.summary.subtitle}\n${s.holdings.size} titoli in portafoglio" +
                        (if (s.analysis.isNotBlank()) "\n${s.analysis}" else "")
                else "⚠️ ${err ?: "Errore sconosciuto"}"
                status.setTextColor(if (err == null) Color.rgb(47, 191, 107) else Color.rgb(240, 82, 82))
            }
        }.start()
    }

    private fun buildUi() {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad * 2, pad, pad * 2) }
        fun text(t: String, size: Float = 16f, bold: Boolean = false) = TextView(this).apply {
            text = t; textSize = size; if (bold) setTypeface(typeface, Typeface.BOLD); setPadding(0, pad / 2, 0, pad / 2)
        }
        col.addView(text("Portafoglio Auto", 26f, true))
        col.addView(text("I tuoi titoli sullo schermo dell'auto con Android Auto, letti ad alta voce."))
        status = text(if (cfg.ok) "" else "Non ancora collegata", 17f, true)
        col.addView(status)

        col.addView(text("Collegamento", 18f, true))
        col.addView(text("Il modo più semplice: nella web app apri il menu account → \"Collega Android Auto\" → \"Collega l'app\". Oppure incolla qui indirizzo e codice.", 14f))
        url = EditText(this).apply { hint = "https://….vercel.app"; setText(cfg.url); inputType = InputType.TYPE_TEXT_VARIATION_URI; isSingleLine = true }
        token = EditText(this).apply { hint = "Codice di collegamento"; setText(cfg.token); isSingleLine = true }
        col.addView(url); col.addView(token)
        col.addView(Button(this).apply {
            text = "Salva e verifica"
            setOnClickListener { cfg.url = url.text.toString(); cfg.token = token.text.toString(); test() }
        })

        col.addView(text("Velocità della voce", 18f, true))
        val rates = listOf("Lenta" to 0.85f, "Normale" to 1.0f, "Veloce" to 1.2f)
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.START }
        val prefs = getSharedPreferences("cfg", MODE_PRIVATE)
        rates.forEach { (label, r) ->
            row.addView(Button(this).apply {
                text = label
                setOnClickListener { prefs.edit().putFloat("rate", r).apply(); status.text = "Velocità: $label" }
            }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        }
        col.addView(row)

        col.addView(text("Attivare l'app in Android Auto (una sola volta)", 18f, true))
        col.addView(text(
            "1. Sul telefono apri Impostazioni → App → Android Auto → Impostazioni aggiuntive nell'app (oppure apri Android Auto).\n" +
            "2. Scorri fino a \"Versione\" e toccala 10 volte → conferma \"Consentire le impostazioni per sviluppatori?\".\n" +
            "3. Menu ⋮ in alto → Impostazioni sviluppatore → attiva \"Fonti sconosciute\".\n" +
            "4. Torna nelle impostazioni di Android Auto → \"Personalizza Avvio app\" e controlla che Portafoglio Auto sia selezionata.\n" +
            "5. Collega il telefono all'auto: trovi \"Portafoglio Auto\" tra le app audio.", 14f))

        col.addView(text("In auto", 18f, true))
        col.addView(text(
            "• Scheda Portafoglio: il riepilogo e un elemento per titolo con la variazione di oggi (freccia verde o rossa).\n" +
            "• Tocca un elemento per ascoltarne la valutazione; avanti/indietro, anche dal volante, passa al titolo vicino.\n" +
            "• Scheda Suggeriti: i titoli da tenere d'occhio con il prezzo d'ingresso.\n" +
            "• I dati si aggiornano ogni minuto.", 14f))
        col.addView(text("Le valutazioni sono segnali tecnici automatici, non consulenza finanziaria.", 12f))

        setContentView(ScrollView(this).apply { addView(col, MATCH_PARENT, WRAP_CONTENT) })
    }
}
