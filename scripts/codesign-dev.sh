#!/bin/sh
# macOS ties a keychain item's ACL to the signature of the binary that created
# it, so an unsigned dev build re-prompts after every rebuild. Signing each run
# with one stable self-signed identity keeps that ACL valid. Create it once:
# Keychain Access -> Certificate Assistant -> Create a Certificate..., name
# "LatentMail Dev", identity type "Self Signed Root", type "Code Signing".
# Without the certificate this is a no-op and the build runs unsigned as before.
# Only the app binary is signed; test binaries would pay the cost for nothing.
#
# Signing only fixes ACLs written from here on. An item an *unsigned* build
# created is pinned to that build's cdhash, which changes every rebuild, and no
# amount of later signing repairs it — authorize the signed build once with
# "Always Allow" at the next prompt, or delete the item and sign in again:
#   security delete-generic-password -s com.latentmail.refresh-token
# A failure here is never fatal — it only costs a keychain re-prompt — but it
# must not be silent, or a missing/renamed certificate looks identical to
# "signing works and the prompt is someone else's fault".
case "$1" in
*/latentmail)
  codesign --force --sign "LatentMail Dev" "$1" >/dev/null 2>&1 ||
    echo "codesign-dev: signing failed; expect a keychain prompt after every rebuild" >&2
  ;;
esac
exec "$@"
