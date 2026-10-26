package com.yuri.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

@CapacitorPlugin(name = "YuriUpdateConfig")
public class YuriUpdateConfigPlugin extends Plugin {
    @PluginMethod
    public void getConfiguration(PluginCall call) {
        // Read the installed APK asset, not Capgo's replaceable web directory.
        try (InputStream stream = getContext().getAssets().open("capacitor.config.json")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int count;
            while ((count = stream.read(buffer)) != -1) bytes.write(buffer, 0, count);
            JSONObject config = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8))
                .getJSONObject("YuriOTA");
            JSObject result = new JSObject();
            result.put("channel", config.getString("channel"));
            result.put("shellApiVersion", config.getInt("shellApiVersion"));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Native update configuration unavailable", error);
        }
    }
}
