#!/usr/bin/env bash
# Emulator smoke: install Track 9 sideload APK, launch MainActivity, require JS past Expo splash
# AND stay alive (no fatal JS/native crash). A mere "Running main" is not enough — 63e4362-era
# hang was splash; c43babe briefly ran main then crashed on crypto.subtle.
set -euo pipefail

APK=$(ls dist/*.apk | head -n 1)
test -f "$APK"
PKG=com.yee94.openchamber.debug
ACTIVITY=com.yee94.openchamber.MainActivity
mkdir -p emulator-smoke

adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 2; done'

adb uninstall "$PKG" >/dev/null 2>&1 || true
adb logcat -c
adb install -r -g "$APK"

adb logcat -v threadtime > emulator-smoke/logcat-full.txt &
LOGCAT_PID=$!

adb shell am start -W -n "$PKG/$ACTIVITY" | tee emulator-smoke/am-start.txt

SAW_JS=0
for i in $(seq 1 60); do
  sleep 2
  adb logcat -d -v brief > emulator-smoke/logcat-snapshot.txt || true

  if grep -Eiq 'Unable to load script|Could not connect to development server|Trying to connect to Metro' emulator-smoke/logcat-snapshot.txt; then
    echo "::error::Metro / missing-bundle failure in logcat"
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    exit 1
  fi

  if grep -Eq "Process: ${PKG}" emulator-smoke/logcat-snapshot.txt && grep -Eq 'FATAL EXCEPTION|JavascriptException' emulator-smoke/logcat-snapshot.txt; then
    echo "::error::FATAL / JavascriptException for $PKG — past splash then crash"
    grep -E "ReactNativeJS|FATAL EXCEPTION|JavascriptException|subtle" emulator-smoke/logcat-snapshot.txt | tail -40 || true
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    exit 1
  fi

  if grep -Eiq "Cannot read property 'subtle' of undefined|WebCrypto subtle unavailable" emulator-smoke/logcat-snapshot.txt; then
    echo "::error::crypto.subtle missing — WebCrypto polyfill not installed before app load"
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    exit 1
  fi
  if grep -Eiq "undefined cannot be used as a constructor|Intl\.Segmenter" emulator-smoke/logcat-snapshot.txt; then
    echo "::error::undefined constructor (often Intl.Segmenter on Hermes)"
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    exit 1
  fi

  if grep -Eq 'ReactNativeJS: Running "main"|ReactNativeJS: Running '\''main'\''' emulator-smoke/logcat-snapshot.txt \
    || grep -Eq 'ReactNativeJS: Running "main"' emulator-smoke/logcat-snapshot.txt; then
    SAW_JS=1
  fi

  if ! adb shell pidof "$PKG" >/dev/null 2>&1; then
    sleep 2
    if ! adb shell pidof "$PKG" >/dev/null 2>&1; then
      echo "::error::App process $PKG not running after launch (crashed?)"
      kill "$LOGCAT_PID" >/dev/null 2>&1 || true
      exit 1
    fi
  fi

  # After JS starts, dwell ~10s more and require process still alive with no fatal.
  if [ "$SAW_JS" = "1" ] && [ "$i" -ge 8 ]; then
    if adb shell pidof "$PKG" >/dev/null 2>&1; then
      echo "OK: ReactNativeJS Running main + process alive at attempt $i"
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
  echo "=== filtered (ReactNativeJS / Expo / SoLoader / AndroidRuntime) ==="
  grep -E "ReactNativeJS|expo.modules|SoLoader|AndroidRuntime|ReactNative|Metro|SplashScreen|Firebase|OpenChamber|subtle|JavascriptException" emulator-smoke/logcat-full.txt || echo "(no matches)"
} | tee emulator-smoke/logcat-evidence.txt

if [ "$SAW_JS" != "1" ]; then
  echo "::error::Timed out without ReactNativeJS Running main — still stuck on Expo splash?"
  exit 1
fi

if ! adb shell pidof "$PKG" >/dev/null 2>&1; then
  echo "::error::Process dead at end of smoke — crash after splash"
  exit 1
fi

if grep -Eq "Process: ${PKG}" emulator-smoke/logcat-full.txt && grep -Eq 'FATAL EXCEPTION|JavascriptException' emulator-smoke/logcat-full.txt; then
  echo "::error::FATAL / JavascriptException present in full logcat"
  exit 1
fi

echo "PASS: emulator smoke past Expo splash and process stable"
