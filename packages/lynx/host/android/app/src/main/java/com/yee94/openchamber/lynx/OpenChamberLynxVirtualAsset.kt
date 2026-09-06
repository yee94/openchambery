package com.yee94.openchamber.lynx

/** openchamber-asset://v/{assetId} resolver + scheme-handler hooks. */
object OpenChamberLynxVirtualAsset {
    const val SCHEME = "openchamber-asset"
    const val MIME_MAX_LENGTH = 128

    fun url(assetId: String): String? {
        if (assetId.length !in 8..80) return null
        if (!assetId.all { it.isLetterOrDigit() || it == '_' || it == '-' }) return null
        return "$SCHEME://v/$assetId"
    }

    fun normalizeMime(mime: String): String? {
        val normalized = mime.trim().lowercase()
        if (normalized.isEmpty() || normalized.length > MIME_MAX_LENGTH) return null
        if (!normalized.startsWith("image/")) return null
        return normalized
    }
}

interface LynxVirtualAssetHandling {
    fun registerSchemeHandler(): Boolean
    fun create(assetId: String, mime: String): Pair<String, String>?
    fun append(assetId: String, chunk: ByteArray): Boolean
    fun finish(assetId: String): Boolean
    fun cancel(assetId: String): Boolean
}

class OpenChamberLynxVirtualAssetHandler : LynxVirtualAssetHandling {
    private val buffers = mutableMapOf<String, ByteArray>()
    private val mimes = mutableMapOf<String, String>()
    var schemeRegistered: Boolean = false
        private set

    override fun registerSchemeHandler(): Boolean {
        // Inject point: intercept openchamber-asset:// with streaming WebResourceResponse /
        // Lynx resource provider. Headers: X-Content-Type-Options: nosniff; one reader/asset.
        schemeRegistered = true
        return true
    }

    override fun create(assetId: String, mime: String): Pair<String, String>? {
        val normalized = OpenChamberLynxVirtualAsset.normalizeMime(mime) ?: return null
        val url = OpenChamberLynxVirtualAsset.url(assetId) ?: return null
        buffers[assetId] = ByteArray(0)
        mimes[assetId] = normalized
        return assetId to url
    }

    override fun append(assetId: String, chunk: ByteArray): Boolean {
        val existing = buffers[assetId] ?: return false
        buffers[assetId] = existing + chunk
        return true
    }

    override fun finish(assetId: String): Boolean = buffers.containsKey(assetId)

    override fun cancel(assetId: String): Boolean {
        mimes.remove(assetId)
        return buffers.remove(assetId) != null
    }
}
