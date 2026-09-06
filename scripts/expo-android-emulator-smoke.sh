#!/usr/bin/env bash
# Emulator smoke: install Track 9 sideload APK, launch MainActivity, require JS past Expo splash.
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

OK=0
for i in $(seq 1 60); do
  sleep 2
  adb logcat -d -v brief > emulator-smoke/logcat-snapshot.txt || true

  if grep -Eiq 'Unable to load script|Could not connect to development server|Trying to connect to Metro' emulator-smoke/logcat-snapshot.txt; then
    echo "::error::Metro / missing-bundle failure in logcat"
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    exit 1
  fi
  if grep -Eiq 'SoLoader:.*couldn.t find|FATAL EXCEPTION.*ReactNative|FirebaseApp.*initializeApp.*IllegalState' emulator-smoke/logcat-snapshot.txt; then
    echo "::error::Native/JS fatal in logcat during cold start"
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    exit 1
  fi

  if grep -Eq 'ReactNativeJS' emulator-smoke/logcat-snapshot.txt; then
    OK=1
    echo "OK: ReactNativeJS markers found at attempt $i"
    break
  fi

  if ! adb shell pidof "$PKG" >/dev/null 2>&1; then
    sleep 3
    if ! adb shell pidof "$PKG" >/dev/null 2>&1; then
      echo "::error::App process $PKG not running after launch"
      kill "$LOGCAT_PID" >/dev/null 2>&1 || true
      exit 1
    fi
  fi
done

sleep 2
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
  grep -E "ReactNativeJS|expo.modules|SoLoader|AndroidRuntime|ReactNative|Metro|SplashScreen|Firebase|OpenChamber" emulator-smoke/logcat-full.txt || echo "(no matches)"
} | tee emulator-smoke/logcat-evidence.txt

if [ "$OK" != "1" ]; then
  echo "::error::Timed out (~120s) without ReactNativeJS evidence — still stuck on Expo splash?"
  exit 1
fi
echo "PASS: emulator smoke past Expo splash"
