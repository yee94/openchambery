package com.yee94.openchamber.lynx

/**
 * Host HTTP client — OkHttp shapes for Lynx inject.
 * Mirrors packages/lynx/src/host/httpClient.ts
 */
data class LynxHostHttpRequest(
    val url: String,
    val method: String = "GET",
    val headers: Map<String, String> = emptyMap(),
    val body: String? = null,
    val timeoutMs: Long = 8_000L,
)

data class LynxHostHttpResponse(
    val ok: Boolean,
    val status: Int,
    val headers: Map<String, String> = emptyMap(),
    val bodyText: String? = null,
)

interface LynxHttpClienting {
    suspend fun request(input: LynxHostHttpRequest): LynxHostHttpResponse?
}

/**
 * Stub OkHttp call factory. Replace [callFactory] when OkHttp / Lynx tunnel is linked.
 * Linux agents never claim a live network call from this stub alone.
 */
class OpenChamberLynxHttpClient(
    private val callFactory: (suspend (LynxHostHttpRequest) -> LynxHostHttpResponse?)? = null,
) : LynxHttpClienting {
    override suspend fun request(input: LynxHostHttpRequest): LynxHostHttpResponse? {
        // Inject point: OkHttpClient.newCall(Request.Builder()...).
        return callFactory?.invoke(input)
    }
}
