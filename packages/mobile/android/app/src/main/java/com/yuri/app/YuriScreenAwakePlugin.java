package com.yuri.app;

import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "YuriScreenAwake")
public class YuriScreenAwakePlugin extends Plugin {
    private boolean enabled = false;
    private boolean paused = false;

    @PluginMethod
    public void setEnabled(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            enabled = call.getBoolean("enabled", false);
            apply();
            call.resolve();
        });
    }

    private void apply() {
        if (enabled && !paused) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override protected void handleOnPause() { paused = true; apply(); }
    @Override protected void handleOnResume() { paused = false; apply(); }
    @Override protected void handleOnDestroy() { enabled = false; apply(); }
}
