package com.yee94.openchamber.lynx

import android.app.Application
import com.facebook.drawee.backends.pipeline.Fresco
import com.facebook.imagepipeline.core.ImagePipelineConfig
import com.facebook.imagepipeline.memory.PoolConfig
import com.facebook.imagepipeline.memory.PoolFactory
import com.lynx.service.http.LynxHttpService
import com.lynx.service.image.LynxImageService
import com.lynx.service.log.LynxLogService
import com.lynx.tasm.LynxEnv
import com.lynx.tasm.service.LynxServiceCenter

/**
 * Application entry for the Lynx sideload host.
 *
 * applicationId is `com.yee94.openchamber.lynx` (+ `.debug` suffix for
 * sideload). Cap/Flutter/Expo keep sharing `com.yee94.openchamber(.debug)`.
 * FCM will not work until a matching Firebase Android app is added — see
 * `docs/lynx-pitfalls.md` §6.
 */
class OpenChamberLynxApp : Application() {
    override fun onCreate() {
        super.onCreate()
        initLynxService()
        initLynxEnv()
    }

    private fun initLynxService() {
        val factory = PoolFactory(PoolConfig.newBuilder().build())
        val builder =
            ImagePipelineConfig.newBuilder(applicationContext).setPoolFactory(factory)
        Fresco.initialize(applicationContext, builder.build())

        LynxServiceCenter.inst().registerService(LynxImageService.getInstance())
        LynxServiceCenter.inst().registerService(LynxLogService.INSTANCE)
        LynxServiceCenter.inst().registerService(LynxHttpService.INSTANCE)
    }

    private fun initLynxEnv() {
        LynxEnv.inst().init(
            this,
            null,
            null,
            null,
        )
    }
}
