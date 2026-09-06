#!/usr/bin/env bash
# Emulator smoke: install Lynx sideload APK, launch HostActivity, require VISIBLE UI
# text (uiautomator) and/or JS splash log — template_load_success alone is TOO WEAK
# (false green on cream void). Mirrors scripts/expo-android-emulator-smoke.sh.
set -euo pipefail

APK=$(ls dist/*.apk | head -n 1)
test -f "$APK"
PKG=com.yee94.openchamber.lynx.debug
ACTIVITY=com.yee94.openchamber.lynx.OpenChamberLynxHostActivity
mkdir -p emulator-smoke

adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 2; done'

adb uninstall "$PKG" >/dev/null 2>&1 || true
adb logcat -c
adb install -r -g "$APK"

adb logcat -v threadtime > emulator-smoke/logcat-full.txt &
LOGCAT_PID=$!

adb shell am start -W -n "$PKG/$ACTIVITY" | tee emulator-smoke/am-start.txt

SAW_UI=0
SAW_SPLASH_LOG=0
UI_EVIDENCE=""

dump_ui_hierarchy() {
  # Prefer uiautomator dump → pull XML; fall back to dumpsys activity / accessibility.
  local dump_path="/sdcard/openchamber-lynx-ui.xml"
  adb shell uiautomator dump "$dump_path" >/dev/null 2>&1 || true
  if adb pull "$dump_path" emulator-smoke/ui.xml >/dev/null 2>&1; then
    cat emulator-smoke/ui.xml
    return 0
  fi
  adb shell dumpsys activity top 2>/dev/null || true
  adb shell dumpsys accessibility 2>/dev/null | head -n 200 || true
}

ui_has_splash_text() {
  local blob="$1"
  if printf '%s' "$blob" | grep -Eq 'Connecting|OpenChamber Lynx|正在连接'; then
    return 0
  fi
  return 1
}

for i in $(seq 1 60); do
  sleep 2
  adb logcat -d -v brief > emulator-smoke/logcat-snapshot.txt || true

  if grep -Eiq 'assets_open_failure|failed to load template|Unable to open asset|FileNotFoundException.*main\.lynx\.bundle' emulator-smoke/logcat-snapshot.txt; then
    echo "::error::assets / template open failure in logcat"
    grep -Ei 'assets_open_failure|failed to load template|main\.lynx\.bundle|FileNotFoundException' emulator-smoke/logcat-snapshot.txt | tail -40 || true
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    exit 1
  fi

  # JS must actually run — template_load_success alone is not enough (TextDecoder crash).
  if grep -Eiq 'TextDecoder is not defined|TextEncoder is not defined|loadCard failed' emulator-smoke/logcat-snapshot.txt; then
    echo "::error::Lynx JS runtime failure (encoding / loadCard) — splash never mounts"
    grep -Ei 'TextDecoder|TextEncoder|loadCard failed|OpenChamberLynx: Lynx' emulator-smoke/logcat-snapshot.txt | tail -40 || true
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    exit 1
  fi
  if grep -Fq 'OpenChamberLynx: Lynx JS error' emulator-smoke/logcat-snapshot.txt; then
    echo "::error::OpenChamberLynx Lynx JS error in logcat"
    grep -F 'OpenChamberLynx: Lynx JS error' emulator-smoke/logcat-snapshot.txt | tail -20 || true
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    exit 1
  fi

  if grep -Eq "Process: ${PKG}" emulator-smoke/logcat-snapshot.txt && grep -Eq 'FATAL EXCEPTION|JavascriptException' emulator-smoke/logcat-snapshot.txt; then
    echo "::error::FATAL / JavascriptException for $PKG"
    grep -E "OpenChamberLynx|LynxView|FATAL EXCEPTION|JavascriptException|AndroidRuntime" emulator-smoke/logcat-snapshot.txt | tail -60 || true
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    exit 1
  fi

  if grep -Fq '[OpenChamberLynx] ConnectWelcome splash' emulator-smoke/logcat-snapshot.txt; then
    SAW_SPLASH_LOG=1
  fi

  # STRICT: require proof of UI text — not template_load_success alone (cream void false green).
  if [ "$SAW_UI" != "1" ] && [ "$i" -ge 3 ]; then
    UI_BLOB=$(dump_ui_hierarchy 2>/dev/null || true)
    printf '%s\n' "$UI_BLOB" > emulator-smoke/ui-latest.txt
    if ui_has_splash_text "$UI_BLOB"; then
      SAW_UI=1
      UI_EVIDENCE=$(printf '%s\n' "$UI_BLOB" | grep -E 'Connecting|OpenChamber Lynx|正在连接' | head -n 3 || true)
      echo "OK: uiautomator/UI text evidence at attempt $i"
      echo "$UI_EVIDENCE"
    fi
  fi

  if ! adb shell pidof "$PKG" >/dev/null 2>&1; then
    sleep 2
    if ! adb shell pidof "$PKG" >/dev/null 2>&1; then
      echo "::error::App process $PKG not running after launch (crashed?)"
      kill "$LOGCAT_PID" >/dev/null 2>&1 || true
      exit 1
    fi
  fi

  # Pass only with UI text proof (preferred) or splash console line if it reaches logcat.
  # template_load_success / first_screen alone MUST NOT pass.
  if { [ "$SAW_UI" = "1" ] || [ "$SAW_SPLASH_LOG" = "1" ]; } && [ "$i" -ge 8 ]; then
    if adb shell pidof "$PKG" >/dev/null 2>&1; then
      echo "OK: UI/splash evidence + process alive at attempt $i (ui=$SAW_UI splash_log=$SAW_SPLASH_LOG)"
      break
    fi
  fi
done

sleep 3
kill "$LOGCAT_PID" >/dev/null 2>&1 || true
wait "$LOGCAT_PID" 2>/dev/null || true
adb logcat -d -v threadtime > emulator-smoke/logcat-full.txt || true

# Final UI dump for artifacts
FINAL_UI=$(dump_ui_hierarchy 2>/dev/null || true)
printf '%s\n' "$FINAL_UI" > emulator-smoke/ui-final.txt
if [ "$SAW_UI" != "1" ] && ui_has_splash_text "$FINAL_UI"; then
  SAW_UI=1
  UI_EVIDENCE=$(printf '%s\n' "$FINAL_UI" | grep -E 'Connecting|OpenChamber Lynx|正在连接' | head -n 3 || true)
fi
if [ "$SAW_SPLASH_LOG" != "1" ] && grep -Fq '[OpenChamberLynx] ConnectWelcome splash' emulator-smoke/logcat-full.txt; then
  SAW_SPLASH_LOG=1
fi

{
  echo "=== am start ==="
  cat emulator-smoke/am-start.txt || true
  echo ""
  echo "=== pidof ==="
  adb shell pidof "$PKG" || echo "(no pid)"
  echo ""
  echo "=== UI evidence ==="
  echo "SAW_UI=$SAW_UI SAW_SPLASH_LOG=$SAW_SPLASH_LOG"
  echo "$UI_EVIDENCE"
  echo ""
  echo "=== filtered (OpenChamberLynx / LynxView / AndroidRuntime) ==="
  grep -E "OpenChamberLynx|LynxView|AndroidRuntime|JavascriptException|FATAL EXCEPTION|main\.lynx\.bundle|ConnectWelcome|first_screen_measured" emulator-smoke/logcat-full.txt || echo "(no matches)"
} | tee emulator-smoke/logcat-evidence.txt

if [ "$SAW_UI" != "1" ] && [ "$SAW_SPLASH_LOG" != "1" ]; then
  echo "::error::Timed out without UI text or ConnectWelcome splash log — cream void / false template_load_success?"
  echo "::error::template_load_success alone is NOT sufficient (strict smoke)."
  exit 1
fi

if ! adb shell pidof "$PKG" >/dev/null 2>&1; then
  echo "::error::Process dead at end of smoke — crash after launch"
  exit 1
fi

if grep -Eq "Process: ${PKG}" emulator-smoke/logcat-full.txt && grep -Eq 'FATAL EXCEPTION|JavascriptException' emulator-smoke/logcat-full.txt; then
  echo "::error::FATAL / JavascriptException present in full logcat"
  exit 1
fi

if grep -Eiq 'assets_open_failure|failed to load template' emulator-smoke/logcat-full.txt; then
  echo "::error::assets open failure present in full logcat"
  exit 1
fi

if grep -Eiq 'TextDecoder is not defined|TextEncoder is not defined|loadCard failed' emulator-smoke/logcat-full.txt; then
  echo "::error::Lynx JS encoding/loadCard failure present in full logcat"
  exit 1
fi

if grep -Fq 'OpenChamberLynx: Lynx JS error' emulator-smoke/logcat-full.txt; then
  echo "::error::OpenChamberLynx Lynx JS error present in full logcat"
  exit 1
fi

echo "PASS: emulator smoke — UI text or splash log proven (not template_load_success alone)"
