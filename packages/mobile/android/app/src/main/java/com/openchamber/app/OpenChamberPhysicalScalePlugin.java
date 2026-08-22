package com.openchamber.app;

import android.util.DisplayMetrics;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "OpenChamberPhysicalScale")
public class OpenChamberPhysicalScalePlugin extends Plugin {
    @PluginMethod
    public void getMetrics(PluginCall call) {
        DisplayMetrics metrics = getContext().getResources().getDisplayMetrics();
        JSObject result = new JSObject();
        result.put("xdpi", (double) metrics.xdpi);
        result.put("ydpi", (double) metrics.ydpi);
        result.put("density", (double) metrics.density);
        result.put("densityDpi", metrics.densityDpi);
        result.put("stableDensityDpi", DisplayMetrics.DENSITY_DEVICE_STABLE);
        call.resolve(result);
    }
}
