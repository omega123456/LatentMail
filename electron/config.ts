/**
 * Build-time / default config for the Electron main process.
 * For local dev, GOOGLE_CLIENT_ID in the environment overrides GOOGLE_CLIENT_ID_DESKTOP.
 *
 * Desktop app OAuth client ID (Google Cloud Console, "Desktop app" type).
 * PKCE is used alongside the client secret (belt-and-suspenders security).
 *
 * GOOGLE_CLIENT_SECRET is loaded from `./secrets` (git-ignored). On a fresh
 * clone, `yarn install` auto-creates `electron/secrets.ts` from
 * `electron/secrets.example.ts` with an empty placeholder — replace it with
 * the real secret from Google Cloud Console.
 */
export const GOOGLE_CLIENT_ID_DESKTOP =
  '217683021815-g51r8d7n3a68sfm590932uams4hh03vj.apps.googleusercontent.com';

export { GOOGLE_CLIENT_SECRET } from './secrets';
