#!/usr/bin/env bash
# Registers an App Store Connect API key with GitHub for notarization.
#
# Create the key first: App Store Connect → Users and Access → Integrations →
# App Store Connect API → Team Keys → (+). Give it the Developer role. The .p8
# downloads once and cannot be downloaded again — keep it somewhere safe.
#
#   ./scripts/setup-notary-key.sh ~/Downloads/AuthKey_XXXXXXXXXX.p8 <KEY_ID> <ISSUER_ID>
set -euo pipefail

P8="${1:?path to the .p8 file}"
KEY_ID="${2:?key id, the XXXXXXXXXX in AuthKey_XXXXXXXXXX.p8}"
ISSUER="${3:?issuer id, the UUID shown above the key list}"
REPO="${REPO:-sbyoun/OmniAgent}"

[ -f "$P8" ] || { echo "no such file: $P8" >&2; exit 1; }

echo "Checking the key against Apple…"
xcrun notarytool history --key "$P8" --key-id "$KEY_ID" --issuer "$ISSUER" >/dev/null
echo "  accepted"

base64 -i "$P8" | gh secret set APPLE_API_KEY_P8 --repo "$REPO"
printf '%s' "$KEY_ID" | gh secret set APPLE_API_KEY_ID --repo "$REPO"
printf '%s' "$ISSUER" | gh secret set APPLE_API_ISSUER --repo "$REPO"

echo "Registered APPLE_API_KEY_P8, APPLE_API_KEY_ID, APPLE_API_ISSUER on $REPO."
echo "For local builds, store it once as a notarytool profile:"
echo "  xcrun notarytool store-credentials omniagent --key $P8 --key-id $KEY_ID --issuer $ISSUER"
