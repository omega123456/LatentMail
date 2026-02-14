import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'MailClient',
    executableName: 'mailclient',
    icon: './assets/icons/icon',
  },
  makers: [
    new MakerSquirrel({
      name: 'MailClient',
    }),
    new MakerDMG({
      name: 'MailClient',
    }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
  ],
};

export default config;
