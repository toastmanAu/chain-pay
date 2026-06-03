package expo.modules.tlspin

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import okhttp3.OkHttpClient
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.security.MessageDigest
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import java.security.cert.CertificateException
import java.io.IOException

class ExpoTlsPinModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoTlsPin")

    AsyncFunction("request") { args: Map<String, Any?>, promise: Promise ->
      try {
        val url = args["url"] as String
        val method = args["method"] as String
        @Suppress("UNCHECKED_CAST")
        val headers = (args["headers"] as Map<String, String>?) ?: emptyMap()
        val body = args["body"] as String?
        val expectedFp = (args["fingerprint"] as String).replace(":", "").uppercase()

        val mismatchFlag = MismatchFlag()
        val trustManager = PinningTrustManager(expectedFp, mismatchFlag)
        val sslContext = SSLContext.getInstance("TLS").apply {
          init(null, arrayOf<TrustManager>(trustManager), null)
        }
        val client = OkHttpClient.Builder()
          .sslSocketFactory(sslContext.socketFactory, trustManager)
          .hostnameVerifier { _, _ -> true } // We pin by cert hash; CN/SAN check is separate.
          .build()

        val reqBuilder = Request.Builder().url(url)
        headers.forEach { (k, v) -> reqBuilder.addHeader(k, v) }
        val requestBody = body?.toRequestBody("application/json".toMediaTypeOrNull())
        when (method.uppercase()) {
          "GET" -> reqBuilder.get()
          "POST" -> reqBuilder.post(requestBody!!)
          "PUT" -> reqBuilder.put(requestBody!!)
          "DELETE" -> if (requestBody != null) reqBuilder.delete(requestBody) else reqBuilder.delete()
          else -> reqBuilder.method(method, requestBody)
        }
        val request = reqBuilder.build()

        try {
          val response: Response = client.newCall(request).execute()
          val respHeaders = mutableMapOf<String, String>()
          response.headers.forEach { respHeaders[it.first] = it.second }
          val respBody = response.body?.string() ?: ""
          promise.resolve(mapOf(
            "ok" to true,
            "status" to response.code,
            "headers" to respHeaders,
            "body" to respBody,
          ))
        } catch (e: IOException) {
          if (mismatchFlag.tripped) {
            promise.resolve(mapOf("ok" to false, "kind" to "tls-mismatch", "detail" to (e.message ?: "")))
          } else {
            promise.resolve(mapOf("ok" to false, "kind" to "network", "detail" to (e.message ?: "")))
          }
        }
      } catch (t: Throwable) {
        promise.resolve(mapOf("ok" to false, "kind" to "network", "detail" to (t.message ?: "")))
      }
    }
  }
}

class MismatchFlag { var tripped = false }

class PinningTrustManager(private val expectedFp: String, private val flag: MismatchFlag) : X509TrustManager {
  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    val leaf = chain?.firstOrNull() ?: throw CertificateException("no cert presented")
    val der = leaf.encoded
    val digest = MessageDigest.getInstance("SHA-256").digest(der)
    val hex = digest.joinToString("") { "%02X".format(it) }
    if (hex != expectedFp) {
      flag.tripped = true
      throw CertificateException("TLS pin mismatch")
    }
  }

  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}
