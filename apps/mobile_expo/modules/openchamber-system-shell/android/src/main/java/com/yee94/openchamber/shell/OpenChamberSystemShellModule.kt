package com.yee94.openchamber.shell

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Base64

class OpenChamberSystemShellModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OpenChamberSystemShell")

    AsyncFunction("getCapabilities") {
      mapOf(
        "platform" to "android",
        "liveActivity" to false,
        "shareAppGroup" to true,
        "uiGlassEffect" to false,
        "uiTabBar" to false
      )
    }

    AsyncFunction("isLiveActivitySupported") {
      mapOf("supported" to false)
    }

    AsyncFunction("startLiveActivity") { _: Map<String, Any?> ->
      // Honest Android no-op — Live Activity is iOS-only.
      emptyMap<String, Any>()
    }

    AsyncFunction("updateLiveActivity") { _: Map<String, Any?> ->
      // no-op
    }

    AsyncFunction("endLiveActivity") { _: Map<String, Any?> ->
      // no-op
    }

    AsyncFunction("updateShareCatalog") { entries: List<Map<String, Any?>> ->
      val prefs = appContext.reactContext?.getSharedPreferences("openchamber_share", Context.MODE_PRIVATE)
        ?: throw Exception("share store unavailable")
      val array = JSONArray()
      entries.forEach { entry ->
        val obj = JSONObject()
        entry.forEach { (k, v) -> obj.put(k, v ?: JSONObject.NULL) }
        array.put(obj)
      }
      prefs.edit().putString("catalog", array.toString()).apply()
    }

    AsyncFunction("listPendingShares") {
      val dir = shareInboxDir()
      val envelopes = dir.listFiles()?.filter { it.extension == "json" }?.mapNotNull { file ->
        try {
          val obj = JSONObject(file.readText())
          obj.keys().asSequence().associateWith { key -> obj.get(key) }
        } catch (_: Exception) {
          null
        }
      }?.sortedByDescending { (it["createdAt"] as? Number)?.toLong() ?: 0L } ?: emptyList()
      mapOf("envelopes" to envelopes)
    }

    AsyncFunction("ackShare") { operationID: String ->
      val file = File(shareInboxDir(), "$operationID.json")
      if (!file.exists()) return@AsyncFunction
      val obj = JSONObject(file.readText())
      obj.put("consumedAt", System.currentTimeMillis())
      file.writeText(obj.toString())
    }

    AsyncFunction("releaseShareFiles") { operationID: String ->
      File(shareInboxDir(), "$operationID.json").delete()
      File(shareInboxDir(), operationID).deleteRecursively()
    }

    AsyncFunction("createVirtualAsset") { assetId: String, mime: String ->
      val ext = when {
        mime.contains("png") -> "png"
        mime.contains("jpeg") || mime.contains("jpg") -> "jpg"
        mime.contains("heic") -> "heic"
        else -> "bin"
      }
      val file = File(virtualDir(), "$assetId.$ext")
      file.writeBytes(ByteArray(0))
      mapOf("assetId" to assetId, "url" to file.toURI().toString())
    }

    AsyncFunction("appendVirtualAsset") { assetId: String, chunkBase64: String ->
      val file = virtualDir().listFiles()?.firstOrNull { it.nameWithoutExtension == assetId }
        ?: throw Exception("virtual asset missing")
      val bytes = Base64.getDecoder().decode(chunkBase64)
      file.appendBytes(bytes)
    }

    AsyncFunction("finishVirtualAsset") { assetId: String ->
      val file = virtualDir().listFiles()?.firstOrNull { it.nameWithoutExtension == assetId }
        ?: throw Exception("virtual asset missing")
      mapOf("url" to file.toURI().toString())
    }

    AsyncFunction("cancelVirtualAsset") { assetId: String ->
      virtualDir().listFiles()?.filter { it.nameWithoutExtension == assetId }?.forEach { it.delete() }
    }
  }

  private fun shareInboxDir(): File {
    val base = appContext.reactContext?.filesDir ?: throw Exception("share store unavailable")
    val dir = File(base, "share-inbox")
    if (!dir.exists()) dir.mkdirs()
    return dir
  }

  private fun virtualDir(): File {
    val base = appContext.reactContext?.cacheDir ?: throw Exception("virtual asset unavailable")
    val dir = File(base, "openchamber-virtual-assets")
    if (!dir.exists()) dir.mkdirs()
    return dir
  }
}
