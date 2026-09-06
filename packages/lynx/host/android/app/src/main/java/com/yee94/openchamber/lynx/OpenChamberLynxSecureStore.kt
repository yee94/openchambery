package com.yee94.openchamber.lynx

/**
 * EncryptedSharedPreferences / Keystore wrapper.
 * Mirrors packages/lynx/src/host/secureStore.ts
 * Cap KeychainAccess.whenUnlocked = 0 → MasterKey AES256_GCM prefs.
 */
interface LynxSecureStoring {
    suspend fun getItem(prefixedKey: String): String?
    suspend fun setItem(prefixedKey: String, data: String, access: Int): Boolean
    suspend fun removeItem(prefixedKey: String): Boolean
}

/**
 * In-memory stub with real API shapes. Device binary swaps in
 * EncryptedSharedPreferences.create(context, file, masterKey, ...).
 * Never log [data] values.
 */
class OpenChamberLynxSecureStore(
    private val memory: MutableMap<String, String> = mutableMapOf(),
) : LynxSecureStoring {
    companion object {
        const val KEYSTORE_ACCESS_WHEN_UNLOCKED = 0
        const val PREFS_FILE = "openchamber_lynx_secure"
    }

    override suspend fun getItem(prefixedKey: String): String? = memory[prefixedKey]

    override suspend fun setItem(prefixedKey: String, data: String, access: Int): Boolean {
        // Inject point: EncryptedSharedPreferences.edit().putString(prefixedKey, data).
        @Suppress("UNUSED_VARIABLE")
        val accessMode = access
        memory[prefixedKey] = data
        return true
    }

    override suspend fun removeItem(prefixedKey: String): Boolean {
        memory.remove(prefixedKey)
        return true
    }
}
