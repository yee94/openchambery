#!/usr/bin/env bash
# Emulator smoke: install Lynx sideload APK, launch HostActivity, require VISIBLE UI
# text via uiautomator literal text="…" attributes.
#
# FALSE-GREEN history (lynx-v2-debug-cfed156 / job 102340406447):
# - grepping the whole XML for "OpenChamber Lynx" matched content-desc alone
# - OR splash console.log alone passed
# Both shipped cream/unstyled void. STRICT: require text="Connecting or
# text="OpenChamber Lynx — NOT content-desc alone, NOT splash console.log alone.
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
UI_EVIDENCE=""

dump_ui_hierarchy() {
  local dump_path="/sdcard/openchamber-lynx-ui.xml"
  adb shell uiautomator dump "$dump_path" >/dev/null 2>&1 || true
  if adb pull "$dump_path" emulator-smoke/ui.xml >/dev/null 2>&1; then
    cat emulator-smoke/ui.xml
    return 0
  fi
  adb shell dumpsys activity top 2>/dev/null || true
  adb shell dumpsys accessibility 2>/dev/null | head -n 200 || true
}

# STRICT: literal text= attribute only — content-desc / console.log do NOT count.
ui_has_literal_text_attr() {
  local blob="$1"
  if printf '%s' "$blob" | grep -Eq 'text="Connecting|text="OpenChamber Lynx'; then
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

  if grep -Eiq 'TextDecoder is not defined|TextEncoder is not defined|loadCard failed' emulator-smoke/logcat-snapshot.txt; then
    echo "::error::Lynx JS runtime failure (encoding / loadCard) — splash never mounts"
    grep -Ei 'TextDecoder|TextEncoder|loadCard failed|OpenChamberLynx' emulator-smoke/logcat-snapshot.txt | tail -40 || true
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    exit 1
  fi
  if grep -Fq 'OpenChamberLynx: Lynx JS error' emulator-smoke/logcat-snapshot.txt; then
    echo "::error::OpenChamberLynx Lynx JS error in logcat"
    grep -F 'OpenChamberLynx: Lynx JS error' emulator-smoke/logcat-snapshot.txt | tail -20 || true
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    exit 1
  fi

  if grep -Eqi 'No BehaviorController defined for class page|createUI catch error while createUI for tag: page' emulator-smoke/logcat-snapshot.txt; then
    echo "::error::Lynx explicit <page> tag failed — use ReactLynx root.render implicit page + <view> roots"
    grep -Ei 'BehaviorController defined for class page|createUI for tag: page|OpenChamberLynx' emulator-smoke/logcat-snapshot.txt | tail -20 || true
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    exit 1
  fi

  if grep -Eq "Process: ${PKG}" emulator-smoke/logcat-snapshot.txt && grep -Eq 'FATAL EXCEPTION|JavascriptException' emulator-smoke/logcat-snapshot.txt; then
    echo "::error::FATAL / JavascriptException for $PKG"
    grep -E "OpenChamberLynx|LynxView|FATAL EXCEPTION|JavascriptException|AndroidRuntime" emulator-smoke/logcat-snapshot.txt | tail -60 || true
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    exit 1
  fi

  if [ "$SAW_UI" != "1" ] && [ "$i" -ge 3 ]; then
    UI_BLOB=$(dump_ui_hierarchy 2>/dev/null || true)
    printf '%s\n' "$UI_BLOB" > emulator-smoke/ui-latest.txt
    if ui_has_literal_text_attr "$UI_BLOB"; then
      SAW_UI=1
      UI_EVIDENCE=$(printf '%s\n' "$UI_BLOB" | grep -E 'text="Connecting|text="OpenChamber Lynx' | head -n 5 || true)
      echo "OK: literal text= attribute evidence at attempt $i"
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

  if [ "$SAW_UI" = "1" ] && [ "$i" -ge 8 ]; then
    if adb shell pidof "$PKG" >/dev/null 2>&1; then
      echo "OK: literal text= UI evidence + process alive at attempt $i (ui=$SAW_UI)"
      break
    fi
  fi
done

sleep 3
kill "$LOGCAT_PID" >/dev/null 2>&1 || true
wait "$LOGCAT_PID" 2>/dev/null || true
adb logcat -d -v threadtime > emulator-smoke/logcat-full.txt || true

FINAL_UI=$(dump_ui_hierarchy 2>/dev/null || true)
printf '%s\n' "$FINAL_UI" > emulator-smoke/ui-final.txt
if [ "$SAW_UI" != "1" ] && ui_has_literal_text_attr "$FINAL_UI"; then
  SAW_UI=1
  UI_EVIDENCE=$(printf '%s\n' "$FINAL_UI" | grep -E 'text="Connecting|text="OpenChamber Lynx' | head -n 5 || true)
fi

{
  echo "=== am start ==="
  cat emulator-smoke/am-start.txt || true
  echo ""
  echo "=== pidof ==="
  adb shell pidof "$PKG" || echo "(no pid)"
  echo ""
  echo "=== UI evidence (literal text= only) ==="
  echo "SAW_UI=$SAW_UI"
  echo "$UI_EVIDENCE"
  echo ""
  echo "=== filtered (OpenChamberLynx / LynxView / AndroidRuntime) ==="
  grep -E "OpenChamberLynx|LynxView|AndroidRuntime|JavascriptException|FATAL EXCEPTION|main\.lynx\.bundle|ConnectWelcome|first_screen_measured" emulator-smoke/logcat-full.txt || echo "(no matches)"
} | tee emulator-smoke/logcat-evidence.txt

if [ "$SAW_UI" != "1" ]; then
  echo "::error::Timed out without literal text=\"Connecting / text=\"OpenChamber Lynx — content-desc or splash log alone is FALSE GREEN"
  echo "::error::template_load_success / first_screen / ConnectWelcome console.log alone are NOT sufficient"
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

if grep -Eqi 'No BehaviorController defined for class page|createUI catch error while createUI for tag: page' emulator-smoke/logcat-full.txt; then
  echo "::error::explicit <page> BehaviorController failure present in full logcat"
  exit 1
fi

echo "PASS: emulator smoke — literal text= attribute proven (not content-desc / splash log / template_load_success)"
