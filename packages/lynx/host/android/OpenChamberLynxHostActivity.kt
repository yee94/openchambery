package com.yee94.openchamber.lynx

/**
 * Scaffold mirror — real Activity lives under
 * `app/src/main/java/.../OpenChamberLynxHostActivity.kt`.
 *
 * Slice 1 lock: Mode A only. A single full-screen LynxView loads the bundle.
 * Chat is a Lynx push that hides the dock. Do not add a fifth Chat destination
 * or a Material bottom nav (that would double-paint chrome).
 *
 * Sideload applicationId is `com.yee94.openchamber.lynx.debug` (unique from
 * Cap/Flutter/Expo `com.yee94.openchamber(.debug)`). See docs/lynx-pitfalls.md §6.
 *
 * Real Activity hardens black-screen: MATCH_PARENT, preset EXACTLY measure,
 * TemplateData/globalProps, LynxViewClient error TextView, cream windowBackground.
 *
 * This mirror is not on the Gradle source path.
 */
object OpenChamberLynxHostActivityMirror
