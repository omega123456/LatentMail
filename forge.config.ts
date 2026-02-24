import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'LatentMail',
    executableName: 'latentmail',
    icon: './assets/icons/icon',
  },
  makers: [
    new MakerSquirrel({
      name: 'LatentMail',
    }),
    new MakerDMG({
      name: 'LatentMail',
    }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
  ],
};

export default config;
