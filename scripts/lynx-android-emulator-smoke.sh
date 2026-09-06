#!/usr/bin/env bash
# Emulator smoke: install Lynx sideload APK, launch HostActivity, require template
# load / JS splash evidence AND stay alive (no FATAL / JS crash / assets open failure).
# Mirrors scripts/expo-android-emulator-smoke.sh (logcat gates only — no screencap).
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

SAW_LYNX=0
for i in $(seq 1 60); do
  sleep 2
  adb logcat -d -v brief > emulator-smoke/logcat-snapshot.txt || true

  if grep -Eiq 'assets_open_failure|failed to load template|Unable to open asset|FileNotFoundException.*main\.lynx\.bundle' emulator-smoke/logcat-snapshot.txt; then
    echo "::error::assets / template open failure in logcat"
    grep -Ei 'assets_open_failure|failed to load template|main\.lynx\.bundle|FileNotFoundException' emulator-smoke/logcat-snapshot.txt | tail -40 || true
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    exit 1
  fi

  if grep -Eq "Process: ${PKG}" emulator-smoke/logcat-snapshot.txt && grep -Eq 'FATAL EXCEPTION|JavascriptException' emulator-smoke/logcat-snapshot.txt; then
    echo "::error::FATAL / JavascriptException for $PKG"
    grep -E "OpenChamberLynx|LynxView|FATAL EXCEPTION|JavascriptException|AndroidRuntime" emulator-smoke/logcat-snapshot.txt | tail -60 || true
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    exit 1
  fi

  # Proof Lynx/JS entered (Expo equivalent of ReactNativeJS Running "main"):
  # host template_load_success / first_screen, or splash console line, or LynxView render.
  if grep -Eq 'OpenChamberLynx.*(template_load_success|first_screen|ConnectWelcome splash)' emulator-smoke/logcat-snapshot.txt \
    || grep -Fq '[OpenChamberLynx] ConnectWelcome splash' emulator-smoke/logcat-snapshot.txt \
    || grep -Eiq 'LynxView.*renderTemplateUrl.*main\.lynx\.bundle' emulator-smoke/logcat-snapshot.txt; then
    SAW_LYNX=1
  fi

  if ! adb shell pidof "$PKG" >/dev/null 2>&1; then
    sleep 2
    if ! adb shell pidof "$PKG" >/dev/null 2>&1; then
      echo "::error::App process $PKG not running after launch (crashed?)"
      kill "$LOGCAT_PID" >/dev/null 2>&1 || true
      exit 1
    fi
  fi

  # After Lynx/JS evidence, dwell ~10s more and require process still alive.
  if [ "$SAW_LYNX" = "1" ] && [ "$i" -ge 8 ]; then
    if adb shell pidof "$PKG" >/dev/null 2>&1; then
      echo "OK: Lynx template/JS evidence + process alive at attempt $i"
      break
    fi
  fi
done

sleep 3
kill "$LOGCAT_PID" >/dev/null 2>&1 || true
wait "$LOGCAT_PID" 2>/dev/null || true
adb logcat -d -v threadtime > emulator-smoke/logcat-full.txt || true

{
  echo "=== am start ==="
  cat emulator-smoke/am-start.txt || true
  echo ""
  echo "=== pidof ==="
  adb shell pidof "$PKG" || echo "(no pid)"
  echo ""
  echo "=== filtered (OpenChamberLynx / LynxView / AndroidRuntime) ==="
  grep -E "OpenChamberLynx|LynxView|AndroidRuntime|JavascriptException|FATAL EXCEPTION|main\.lynx\.bundle|ConnectWelcome" emulator-smoke/logcat-full.txt || echo "(no matches)"
} | tee emulator-smoke/logcat-evidence.txt

if [ "$SAW_LYNX" != "1" ]; then
  echo "::error::Timed out without Lynx template/JS evidence — black screen / failed load?"
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

echo "PASS: emulator smoke past Lynx template load and process stable"
