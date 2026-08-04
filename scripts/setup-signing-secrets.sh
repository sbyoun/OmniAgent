#!/bin/zsh
# Registers the macOS signing/notarization secrets this repo's release
# workflow needs. Run it yourself — nothing secret is printed, and the
# temporary .p12 is deleted at the end.
#
#   ./scripts/setup-signing-secrets.sh
#
# Prompts appear for: the keychain (allow access to the private key) and,
# at the end, your Apple ID e-mail and app-specific password.

set -e
REPO="sbyoun/OmniAgent"
P12=/tmp/omniagent-signing.p12
cleanup() { rm -f "$P12"; }
trap cleanup EXIT

command -v gh >/dev/null || { echo "gh CLI가 필요합니다"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh auth login 이 필요합니다"; exit 1; }

echo "1/4  서명 인증서 확인…"
security find-identity -v -p codesigning | grep -q "Developer ID Application" \
  || { echo "  ✗ Developer ID Application 인증서를 찾지 못했습니다"; exit 1; }
IDENTITY=$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)"/\1/')
TEAM_ID=$(echo "$IDENTITY" | sed -n 's/.*(\(.*\))/\1/p')
echo "  ✓ $IDENTITY"

echo "2/4  인증서(.p12) 확인"
# Xcode 15+ keeps signing keys in the data-protection keychain, which the
# legacy `security export` cannot read — so the .p12 has to come from Xcode:
#   Xcode → Settings → Accounts → (팀 선택) → Manage Certificates… →
#   "Developer ID Application" 우클릭 → Export Certificate… → .p12 저장
P12_SRC="${1:-}"
if [ -z "$P12_SRC" ]; then
  for cand in ~/Desktop/*.p12 ~/Downloads/*.p12; do
    [ -f "$cand" ] && { P12_SRC="$cand"; break; }
  done
fi
if [ -z "$P12_SRC" ] || [ ! -f "$P12_SRC" ]; then
  cat <<'GUIDE'
  ✗ .p12 파일을 찾지 못했습니다.

  Xcode에서 내보내 주세요 (Xcode가 만든 인증서는 이 방법만 가능합니다):
    Xcode → Settings… → Accounts → 팀 선택 → Manage Certificates…
    → "Developer ID Application" 우클릭 → Export Certificate…
    → 비밀번호를 정해 저장 (예: ~/Desktop/oa.p12)

  저장한 뒤 다시 실행:
    ./scripts/setup-signing-secrets.sh ~/Desktop/oa.p12
GUIDE
  exit 1
fi
cp "$P12_SRC" "$P12"
echo "  ✓ $P12_SRC ($(wc -c < "$P12" | tr -d ' ') bytes)"
printf '  이 .p12를 저장할 때 정한 비밀번호: '
read -rs PW; echo
openssl pkcs12 -in "$P12" -passin "pass:$PW" -nokeys -legacy >/dev/null 2>&1 \
  || openssl pkcs12 -in "$P12" -passin "pass:$PW" -nokeys >/dev/null 2>&1 \
  || { echo "  ✗ 비밀번호가 맞지 않습니다"; exit 1; }
echo "  ✓ 비밀번호 확인됨"
echo "  ✓ $(wc -c < "$P12" | tr -d ' ') bytes"

echo "3/4  GitHub 시크릿 등록 (인증서·비밀번호·식별자)…"
base64 < "$P12" | gh secret set APPLE_CERTIFICATE -R "$REPO"
printf '%s' "$PW" | gh secret set APPLE_CERTIFICATE_PASSWORD -R "$REPO"
printf '%s' "$IDENTITY" | gh secret set APPLE_SIGNING_IDENTITY -R "$REPO"
printf '%s' "$TEAM_ID" | gh secret set APPLE_TEAM_ID -R "$REPO"
echo "  ✓ APPLE_CERTIFICATE / APPLE_CERTIFICATE_PASSWORD / APPLE_SIGNING_IDENTITY / APPLE_TEAM_ID"

echo "4/4  애플 계정 정보 (공증용) — 값은 화면에 표시되지 않습니다"
printf '  Apple ID 이메일: '
read -r APPLE_ID_VALUE
printf '%s' "$APPLE_ID_VALUE" | gh secret set APPLE_ID -R "$REPO"
printf '  앱 암호(app-specific password): '
read -rs APPLE_PW_VALUE; echo
printf '%s' "$APPLE_PW_VALUE" | gh secret set APPLE_PASSWORD -R "$REPO"
echo "  ✓ APPLE_ID / APPLE_PASSWORD"

echo
echo "완료. 등록된 시크릿:"
gh secret list -R "$REPO"
