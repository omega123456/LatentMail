import { app } from 'electron';

/**
 * Sets whether the app should launch at OS login (macOS and Windows).
 */
export function setLaunchAtLogin(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled });
}

/**
 * Returns whether the app is currently set to launch at OS login.
 */
export function getLaunchAtLogin(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}
