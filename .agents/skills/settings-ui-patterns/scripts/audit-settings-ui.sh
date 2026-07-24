#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "usage: audit-settings-ui.sh <settings-page-or-directory> [...]" >&2
  exit 2
fi

for target in "$@"; do
  if [[ ! -e "$target" ]]; then
    echo "Settings design audit target does not exist: $target" >&2
    exit 2
  fi
done

legacy_pattern='<h[34][^>]*typography-ui-header|data-settings-item=[^>]*(mb-8|space-y-[0-9])|<section[^>]*className="[^"]*px-2 pb-2 pt-0'

if rg -n --glob '*.tsx' "$legacy_pattern" "$@"; then
  echo >&2
  echo "Settings design audit found a legacy section recipe." >&2
  echo "Use SettingsGroup, SettingsField, SettingsRow, and SettingsToggleRow;" >&2
  echo "review SETTINGS_DESIGN_SPEC.md before allowing an intentional exception." >&2
  exit 1
fi

echo "Settings design audit passed for $# path(s)."
