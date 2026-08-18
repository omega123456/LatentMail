#!/bin/sh
# macOS pins a keychain item's ACL to the designated requirement of the binary
# that created it, and re-checks that requirement on every read. An unsigned
# build's requirement embeds its cdhash, which changes on every relink, so the
# app re-prompts after each Rust rebuild.
#
# Ad-hoc signing with a fixed identifier and an explicit designated requirement
# gives every build the same requirement. No certificate and no private key are
# involved, so codesign itself never prompts for keychain access either — a
# self-signed identity does, on every relink, and its untrusted chain also fails
# the signature check the ACL match runs, which is why "Always Allow" never
# stuck. Only the app binary is signed; test binaries would pay for nothing.
#
# The ACL of an item an earlier build created still names that build's
# requirement, so authorize this one once with "Always Allow" at the next
# prompt, or start over:
#   security delete-generic-password -s com.latentmail.refresh-token
# A failure here is never fatal — it only costs a keychain re-prompt — but it
# must not be silent, or it looks identical to "signing works and the prompt is
# someone else's fault".
case "$1" in
*/latentmail)
  codesign --force --sign - --identifier com.latentmail.dev \
    --requirements '=designated => identifier "com.latentmail.dev"' "$1" >/dev/null 2>&1 ||
    echo "codesign-dev: signing failed; expect a keychain prompt after every rebuild" >&2
  ;;
esac
exec "$@"
