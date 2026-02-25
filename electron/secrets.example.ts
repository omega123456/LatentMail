/**
 * Google OAuth 2.0 client secret for the Desktop app OAuth client.
 *
 * WHERE TO FIND IT:
 *   Google Cloud Console → APIs & Services → Credentials
 *   → OAuth 2.0 Client IDs → your Desktop app client → Client secret
 *
 * HOW TO USE:
 *   This file is the committed template. `electron/secrets.ts` is the git-ignored
 *   file that holds your real secret. It is auto-created by `yarn install`
 *   (via the `postinstall` script) with an empty placeholder — replace the
 *   empty string with the real value from Google Cloud Console.
 *
 *   DO NOT put the real secret in this file — it is committed to git.
 */
export const GOOGLE_CLIENT_SECRET = '';
