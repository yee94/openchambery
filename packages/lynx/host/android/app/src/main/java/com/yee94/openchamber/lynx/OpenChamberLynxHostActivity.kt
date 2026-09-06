package com.yee94.openchamber.lynx

import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.lynx.tasm.LynxError
import com.lynx.tasm.LynxView
import com.lynx.tasm.LynxViewBuilder
import com.lynx.tasm.LynxViewClient
import com.lynx.tasm.TemplateData
import com.lynx.xelement.XElementBehaviors

/**
 * Android host for the Lynx phone shell.
 *
 * Slice 1 lock: Mode A only. A single full-screen LynxView loads the bundle.
 * Chat is a Lynx push that hides the dock. Do not add a fifth Chat destination
 * or a Material bottom nav (that would double-paint chrome).
 *
 * Sideload applicationId is `com.yee94.openchamber.lynx.debug` so this APK
 * installs beside Cap/Flutter/Expo (`com.yee94.openchamber(.debug)`). FCM will
 * not work until a matching Firebase Android app is added
 * (`docs/lynx-pitfalls.md` §6). This file does not register push.
 *
 * Black-screen hardening:
 * - MATCH_PARENT FrameLayout + LynxView
 * - preset EXACTLY measure specs from DisplayMetrics (4.0 equivalent of
 *   LynxViewSizeModeExact / preferredLayoutWidth/Height)
 * - TemplateData init + updateGlobalProps from ViewFactory.globalProps
 * - LynxViewClient logs + optional error TextView (never silent black)
 * - Theme windowBackground is Flexoki cream (not black)
 */
class OpenChamberLynxHostActivity : AppCompatActivity() {
    private val decision = OpenChamberLynxEmbedding.resolve()
    private var errorView: TextView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        check(decision.mode == LynxEmbeddingMode.A)
        check(decision.androidGlassDowngrade)

        val root =
            FrameLayout(this).apply {
                layoutParams =
                    ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                setBackgroundColor(Color.parseColor("#fffdf4"))
            }

        val metrics = resources.displayMetrics
        val lynxView = buildLynxView(metrics.widthPixels, metrics.heightPixels)
        root.addView(
            lynxView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )

        errorView =
            TextView(this).apply {
                visibility = View.GONE
                setTextColor(Color.parseColor("#100F0F"))
                setBackgroundColor(Color.parseColor("#fffdf4"))
                setPadding(48, 48, 48, 48)
                textSize = 14f
                gravity = Gravity.CENTER
                layoutParams =
                    FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
            }
        root.addView(errorView)

        setContentView(root)

        val globalProps = OpenChamberLynxViewFactory.globalProps(decision)
        Log.i(TAG, "template_render_start url=${OpenChamberLynxViewFactory.BUNDLE_URL}")
        lynxView.updateGlobalProps(globalProps)
        lynxView.renderTemplateUrl(
            OpenChamberLynxViewFactory.BUNDLE_URL,
            TemplateData.fromMap(globalProps),
        )
    }

    private fun buildLynxView(widthPx: Int, heightPx: Int): LynxView {
        val widthSpec = View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY)
        val heightSpec = View.MeasureSpec.makeMeasureSpec(heightPx, View.MeasureSpec.EXACTLY)

        val viewBuilder = LynxViewBuilder()
        viewBuilder.addBehaviors(XElementBehaviors().create())
        viewBuilder.setTemplateProvider(OpenChamberLynxTemplateProvider(this))
        // 4.0 Android equivalent of preferredLayout + LynxViewSizeModeExact.
        viewBuilder.setScreenSize(widthPx, heightPx)
        viewBuilder.setPresetMeasuredSpec(widthSpec, heightSpec)

        val lynxView = viewBuilder.build(this)
        lynxView.addLynxViewClient(
            object : LynxViewClient() {
                override fun onPageStart(url: String?) {
                    Log.i(TAG, "template_page_start url=$url")
                }

                override fun onLoadSuccess() {
                    Log.i(TAG, "template_load_success")
                }

                override fun onFirstScreen() {
                    Log.i(TAG, "first_screen")
                    // Force a second layout pass — some hosts paint cream void until requestLayout.
                    lynxView.post {
                        lynxView.requestLayout()
                        lynxView.invalidate()
                        val w = lynxView.width
                        val h = lynxView.height
                        Log.i(TAG, "first_screen_measured width=$w height=$h")
                        if (w <= 0 || h <= 0) {
                            showHostError("LynxView measured ${w}x${h} after first_screen (expected non-zero)")
                        }
                    }
                }

                override fun onLoadFailed(message: String?) {
                    showHostError("Lynx load failed: ${message ?: "unknown"}")
                }

                override fun onReceivedError(error: LynxError?) {
                    showHostError("Lynx error: ${error?.msg ?: error?.toString() ?: "unknown"}")
                }

                override fun onReceivedJSError(jsError: LynxError?) {
                    showHostError("Lynx JS error: ${jsError?.msg ?: jsError?.toString() ?: "unknown"}")
                }
            },
        )
        return lynxView
    }

    private fun showHostError(message: String) {
        Log.e(TAG, message)
        runOnUiThread {
            errorView?.let { tv ->
                tv.text = message
                tv.visibility = View.VISIBLE
                tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            }
        }
    }

    companion object {
        private const val TAG = "OpenChamberLynx"
    }
}
