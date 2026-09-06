package com.yee94.openchamber.lynx

/**
 * Custom Tabs OAuth launcher stub.
 * Mirrors packages/lynx/src/host/oauthBrowser.ts
 * Inject: CustomTabsIntent + openchamber:// intent-filter resume.
 */
sealed class LynxOAuthBrowserResult {
    data class Ok(val callbackUrl: String?) : LynxOAuthBrowserResult()
    object Cancelled : LynxOAuthBrowserResult()
    object Unavailable : LynxOAuthBrowserResult()
    data class Failed(val error: String) : LynxOAuthBrowserResult()
}

interface LynxOAuthBrowsing {
    suspend fun openAuthorize(
        url: String,
        callbackScheme: String,
        prefersEphemeral: Boolean,
    ): LynxOAuthBrowserResult
}

class OpenChamberLynxOAuthBrowser(
    private val launcher: (suspend (url: String, callbackScheme: String) -> LynxOAuthBrowserResult)? = null,
) : LynxOAuthBrowsing {
    override suspend fun openAuthorize(
        url: String,
        callbackScheme: String,
        prefersEphemeral: Boolean,
    ): LynxOAuthBrowserResult {
        // Inject point:
        // CustomTabsIntent.Builder().build().launchUrl(activity, Uri.parse(url))
        // + Activity result / deep link for `$callbackScheme://...`
        if (launcher == null) return LynxOAuthBrowserResult.Unavailable
        @Suppress("UNUSED_VARIABLE")
        val ephemeral = prefersEphemeral
        return launcher.invoke(url, callbackScheme)
    }
}
