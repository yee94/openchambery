package com.openchamber.app;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.JSObject;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;

@CapacitorPlugin(name = "OpenChamberShare")
public class OpenChamberSharePlugin extends Plugin {
    @PluginMethod public void updateCatalog(PluginCall call) { try { JSONArray entries = call.getArray("entries"); if (entries == null) throw new IllegalArgumentException("entries is required"); OpenChamberShareStore.updateCatalog(getContext(), entries); call.resolve(); } catch (Exception error) { call.reject(error.getMessage(), error); } }
    @PluginMethod public void listPending(PluginCall call) { try { JSObject result = new JSObject(); result.put("envelopes", OpenChamberShareStore.pending(getContext())); call.resolve(result); } catch (Exception error) { call.reject(error.getMessage(), error); } }
    @PluginMethod public void ack(PluginCall call) { String id = call.getString("operationID"); if (id == null || !id.matches("[A-Za-z0-9-]{1,80}")) { call.reject("A valid operationID is required."); return; } try { OpenChamberShareStore.acknowledge(getContext(), id); call.resolve(); } catch (Exception error) { call.reject(error.getMessage(), error); } }
    @PluginMethod public void releaseFiles(PluginCall call) { String id = call.getString("operationID"); if (id == null || !id.matches("[A-Za-z0-9-]{1,80}")) { call.reject("A valid operationID is required."); return; } try { OpenChamberShareStore.releaseAcknowledged(getContext(), id); call.resolve(); } catch (Exception error) { call.reject(error.getMessage(), error); } }
    void emitReceived(String operationID) { JSObject event = new JSObject(); event.put("operationID", operationID); notifyListeners("shareReceived", event); }
}
