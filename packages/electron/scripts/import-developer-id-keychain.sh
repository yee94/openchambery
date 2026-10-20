#!/usr/bin/env bash
# Import CSC_LINK (base64 Developer ID .p12) into a temp keychain.
# electron-builder's helper fails on macos-26 with:
#   security set-key-partition-list ... -k $CSC_KEY_PASSWORD
#   SecKeychainUnlock: The user name or passphrase you entered is not correct.
# because it unlocks its temp keychain with the p12 password, not the keychain password.
set -euo pipefail

if [[ -z "${CSC_LINK:-}" || -z "${CSC_KEY_PASSWORD:-}" ]]; then
  echo "CSC_LINK and CSC_KEY_PASSWORD are required." >&2
  exit 1
fi
if [[ -z "${RUNNER_TEMP:-}" ]]; then
  echo "RUNNER_TEMP is required." >&2
  exit 1
fi

cert_path="$RUNNER_TEMP/developer-id.p12"
keychain_path="$RUNNER_TEMP/developer-id.keychain-db"
# Same password strategy as mobile-release iOS signing.
keychain_password="$RUNNER_TEMP"

printf '%s' "$CSC_LINK" | base64 -D > "$cert_path"
if [[ ! -s "$cert_path" ]]; then
  echo "Failed to decode CSC_LINK as a base64 p12." >&2
  exit 1
fi

security delete-keychain "$keychain_path" 2>/dev/null || true
security create-keychain -p "$keychain_password" "$keychain_path"
security set-keychain-settings -lut 21600 "$keychain_path"
security unlock-keychain -p "$keychain_password" "$keychain_path"
security import "$cert_path" \
  -P "$CSC_KEY_PASSWORD" \
  -A -t cert -f pkcs12 \
  -k "$keychain_path" \
  -T /usr/bin/codesign \
  -T /usr/bin/security \
  -T /usr/bin/productbuild
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain_path"
# Add the throwaway keychain to the search list without dropping the user's
# existing keychains. Replacing the list (and making it the default keychain)
# makes every other app on a self-hosted Mac prompt for this keychain's
# password, which nobody can type: it is the RUNNER_TEMP path.
previous_keychains=()
while IFS= read -r existing; do
  existing="${existing#"${existing%%[![:space:]]*}"}"
  existing="${existing%"${existing##*[![:space:]]}"}"
  existing="${existing#\"}"
  existing="${existing%\"}"
  if [[ -n "$existing" && "$existing" != "$keychain_path" ]]; then
    previous_keychains+=("$existing")
  fi
done < <(security list-keychains -d user)

if [[ ${#previous_keychains[@]} -gt 0 ]]; then
  security list-keychains -d user -s "$keychain_path" "${previous_keychains[@]}"
else
  security list-keychains -d user -s "$keychain_path"
fi
rm -f "$cert_path"

if ! security find-identity -v -p codesigning "$keychain_path" | grep -q "Developer ID Application"; then
  echo "Developer ID Application identity not found after import." >&2
  security find-identity -v -p codesigning "$keychain_path" >&2
  exit 1
fi

echo "Imported Developer ID certificate into $keychain_path"
