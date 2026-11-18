@file:androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])

package it.brondomiki.portafoglio

import android.content.Context
import android.net.Uri
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.FileDataSource
import androidx.media3.datasource.TransferListener

/**
 * Sorgente audio "tts://speech?id=...": al momento della riproduzione prende il testo più recente
 * per quella voce, lo trasforma in audio con la sintesi vocale e lo passa al lettore.
 */
class TtsDataSource(private val ctx: Context) : DataSource {
    private val file = FileDataSource()
    private var uri: Uri? = null

    override fun addTransferListener(transferListener: TransferListener) = file.addTransferListener(transferListener)

    override fun open(dataSpec: DataSpec): Long {
        uri = dataSpec.uri
        val id = dataSpec.uri.getQueryParameter("id") ?: ""
        Store.ensureFresh(ctx, 60_000)
        val audio = Speaker.synthesizeBlocking(ctx, Store.textFor(id))
        return file.open(dataSpec.buildUpon().setUri(Uri.fromFile(audio)).build())
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int = file.read(buffer, offset, length)
    override fun getUri(): Uri? = uri
    override fun close() = file.close()

    class Factory(private val ctx: Context) : DataSource.Factory {
        override fun createDataSource(): DataSource = TtsDataSource(ctx)
    }
}
