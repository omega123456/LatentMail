import { access, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';

const path = new URL('../src-tauri/secrets.json', import.meta.url);

try {
  await access(path, constants.F_OK);
  throw new Error('src-tauri/secrets.json already exists; refusing to overwrite it.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

await writeFile(path, '{\n  "googleClientId": "",\n  "googleClientSecret": ""\n}\n');
