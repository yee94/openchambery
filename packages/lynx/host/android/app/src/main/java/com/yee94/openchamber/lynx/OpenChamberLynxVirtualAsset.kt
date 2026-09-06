package com.yee94.openchamber.lynx

/** openchamber-asset://v/{assetId} resolver hooks. */
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
