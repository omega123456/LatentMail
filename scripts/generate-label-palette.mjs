import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHUNK_SIZE = 26;
const FIRST_CHUNK_INDEX = 1;
const LIGHT_TINT_OPACITY = '12';
const DARK_TINT_OPACITY = '18';
const LIGHT_BORDER_OPACITY = '25';
const DARK_BORDER_OPACITY = '30';

const SOURCE_SWATCHES = [
  ['black', 'Black', '#000000', '#ffffff'],
  ['charcoal', 'Charcoal', '#434343', '#ffffff'],
  ['slate-grey', 'Slate Grey', '#666666', '#ffffff'],
  ['grey', 'Grey', '#999999', '#ffffff'],
  ['silver', 'Silver', '#cccccc', '#000000'],
  ['fog', 'Fog', '#efefef', '#000000'],
  ['mist', 'Mist', '#f3f3f3', '#000000'],
  ['white', 'White', '#ffffff', '#000000'],
  ['red', 'Red', '#fb4c2f', '#ffffff'],
  ['orange', 'Orange', '#ffad47', '#000000'],
  ['amber', 'Amber', '#fad165', '#000000'],
  ['green', 'Green', '#16a766', '#ffffff'],
  ['mint', 'Mint', '#43d692', '#000000'],
  ['blue', 'Blue', '#4a86e8', '#ffffff'],
  ['purple', 'Purple', '#a479e2', '#ffffff'],
  ['pink', 'Pink', '#f691b3', '#000000'],
  ['peach', 'Peach', '#f6c5be', '#000000'],
  ['cream', 'Cream', '#ffe6c7', '#000000'],
  ['butter', 'Butter', '#fef1d1', '#000000'],
  ['sage', 'Sage', '#b9e4d0', '#000000'],
  ['seafoam', 'Seafoam', '#c6f3de', '#000000'],
  ['sky', 'Sky', '#c9daf8', '#000000'],
  ['lavender', 'Lavender', '#e4d7f5', '#000000'],
  ['blush', 'Blush', '#fcdee8', '#000000'],
  ['light-red', 'Light Red', '#efa093', '#000000'],
  ['light-orange', 'Light Orange', '#ffd6a2', '#000000'],
  ['light-amber', 'Light Amber', '#fce8b3', '#000000'],
  ['emerald', 'Emerald', '#89d3b2', '#000000'],
  ['light-emerald', 'Light Emerald', '#a0eac9', '#000000'],
  ['light-blue', 'Light Blue', '#a4c2f4', '#000000'],
  ['light-violet', 'Light Violet', '#d0bcf1', '#000000'],
  ['pale-rose', 'Pale Rose', '#fbc8d9', '#000000'],
  ['red-2', 'Red 2', '#e66550', '#ffffff'],
  ['orange-2', 'Orange 2', '#ffbc6b', '#000000'],
  ['light-amber-2', 'Light Amber 2', '#fcda83', '#000000'],
  ['deep-emerald', 'Deep Emerald', '#44b984', '#ffffff'],
  ['emerald-2', 'Emerald 2', '#68dfa9', '#000000'],
  ['blue-2', 'Blue 2', '#6d9eeb', '#ffffff'],
  ['violet', 'Violet', '#b694e8', '#000000'],
  ['light-rose', 'Light Rose', '#f7a7c0', '#000000'],
  ['deep-red', 'Deep Red', '#cc3a21', '#ffffff'],
  ['orange-3', 'Orange 3', '#eaa041', '#000000'],
  ['amber-2', 'Amber 2', '#f2c960', '#000000'],
  ['dark-emerald', 'Dark Emerald', '#149e60', '#ffffff'],
  ['deep-emerald-2', 'Deep Emerald 2', '#3dc789', '#ffffff'],
  ['deep-blue', 'Deep Blue', '#3c78d8', '#ffffff'],
  ['violet-2', 'Violet 2', '#8e63ce', '#ffffff'],
  ['rose', 'Rose', '#e07798', '#ffffff'],
  ['deep-red-2', 'Deep Red 2', '#ac2b16', '#ffffff'],
  ['deep-orange', 'Deep Orange', '#cf8933', '#ffffff'],
  ['amber-3', 'Amber 3', '#d5ae49', '#000000'],
  ['dark-emerald-2', 'Dark Emerald 2', '#0b804b', '#ffffff'],
  ['deep-emerald-3', 'Deep Emerald 3', '#2a9c68', '#ffffff'],
  ['deep-blue-2', 'Deep Blue 2', '#285bac', '#ffffff'],
  ['deep-violet', 'Deep Violet', '#653e9b', '#ffffff'],
  ['deep-rose', 'Deep Rose', '#b65775', '#ffffff'],
  ['dark-red', 'Dark Red', '#822111', '#ffffff'],
  ['deep-orange-2', 'Deep Orange 2', '#a46a21', '#ffffff'],
  ['deep-amber', 'Deep Amber', '#aa8831', '#ffffff'],
  ['dark-emerald-3', 'Dark Emerald 3', '#076239', '#ffffff'],
  ['dark-emerald-4', 'Dark Emerald 4', '#1a764d', '#ffffff'],
  ['dark-blue', 'Dark Blue', '#1c4587', '#ffffff'],
  ['dark-violet', 'Dark Violet', '#41236d', '#ffffff'],
  ['deep-rose-2', 'Deep Rose 2', '#83334c', '#ffffff'],
  ['graphite', 'Graphite', '#464646', '#ffffff'],
  ['fog-2', 'Fog 2', '#e7e7e7', '#000000'],
  ['dark-blue-2', 'Dark Blue 2', '#0d3472', '#ffffff'],
  ['light-blue-2', 'Light Blue 2', '#b6cff5', '#000000'],
  ['dark-cyan', 'Dark Cyan', '#0d3b44', '#ffffff'],
  ['cyan', 'Cyan', '#98d7e4', '#000000'],
  ['dark-violet-2', 'Dark Violet 2', '#3d188e', '#ffffff'],
  ['pale-violet', 'Pale Violet', '#e3d7ff', '#000000'],
  ['dark-rose', 'Dark Rose', '#711a36', '#ffffff'],
  ['pale-rose-2', 'Pale Rose 2', '#fbd3e0', '#000000'],
  ['dark-red-2', 'Dark Red 2', '#8a1c0a', '#ffffff'],
  ['light-red-2', 'Light Red 2', '#f2b2a8', '#000000'],
  ['dark-orange', 'Dark Orange', '#7a2e0b', '#ffffff'],
  ['light-orange-2', 'Light Orange 2', '#ffc8af', '#000000'],
  ['dark-orange-2', 'Dark Orange 2', '#7a4706', '#ffffff'],
  ['light-orange-3', 'Light Orange 3', '#ffdeb5', '#000000'],
  ['dark-gold', 'Dark Gold', '#594c05', '#ffffff'],
  ['gold', 'Gold', '#fbe983', '#000000'],
  ['dark-amber', 'Dark Amber', '#684e07', '#ffffff'],
  ['light-amber-3', 'Light Amber 3', '#fdedc1', '#000000'],
  ['dark-emerald-5', 'Dark Emerald 5', '#0b4f30', '#ffffff'],
  ['light-emerald-2', 'Light Emerald 2', '#b3efd3', '#000000'],
  ['dark-emerald-6', 'Dark Emerald 6', '#04502e', '#ffffff'],
  ['emerald-3', 'Emerald 3', '#a2dcc1', '#000000'],
  ['silver-2', 'Silver 2', '#c2c2c2', '#000000'],
  ['blue-3', 'Blue 3', '#4986e7', '#ffffff'],
  ['deep-cyan', 'Deep Cyan', '#2da2bb', '#ffffff'],
  ['light-violet-2', 'Light Violet 2', '#b99aff', '#000000'],
  ['deep-rose-3', 'Deep Rose 3', '#994a64', '#ffffff'],
  ['light-rose-2', 'Light Rose 2', '#f691b2', '#000000'],
  ['orange-4', 'Orange 4', '#ff7537', '#ffffff'],
  ['orange-5', 'Orange 5', '#ffad46', '#000000'],
  ['dark-red-3', 'Dark Red 3', '#662e37', '#ffffff'],
  ['pale-red', 'Pale Red', '#ebdbde', '#000000'],
  ['red-3', 'Red 3', '#cca6ac', '#000000'],
  ['dark-emerald-7', 'Dark Emerald 7', '#094228', '#ffffff'],
  ['deep-emerald-4', 'Deep Emerald 4', '#42d692', '#000000'],
  ['deep-emerald-5', 'Deep Emerald 5', '#16a765', '#ffffff'],
];

function formatSwatchEntry(entry, index) {
  const [id, name, gmailBackground, gmailText] = entry;
  const light = `label-gmail-${index}`;
  const dark = `dark-label-gmail-${index}`;
  const lines = [
    '  {',
    `    id: '${id}',`,
    `    name: '${name}',`,
    `    backgroundClass: 'bg-${light} dark:bg-${dark}',`,
    `    textClass: 'text-label-on-gmail-${index} dark:text-dark-label-on-gmail-${index}',`,
    `    dotClass: 'bg-${light} dark:bg-${dark}',`,
    `    tintClass: 'bg-${light}/${LIGHT_TINT_OPACITY} dark:bg-${dark}/${DARK_TINT_OPACITY}',`,
    `    borderClass: 'border-${light}/${LIGHT_BORDER_OPACITY} dark:border-${dark}/${DARK_BORDER_OPACITY}',`,
    `    inkClass: 'text-label-ink-${index} dark:text-dark-label-ink-${index}',`,
    `    gmailBackground: '${gmailBackground}',`,
    `    gmailText: '${gmailText}',`,
    '  },',
  ];
  return lines.join('\n');
}

function renderChunkModule(chunkNumber, formattedEntries) {
  return [
    "import type { LabelColorSwatch } from './palette-types';",
    '',
    `export const PALETTE_SWATCHES_${chunkNumber}: LabelColorSwatch[] = [`,
    ...formattedEntries,
    '];',
    '',
  ].join('\n');
}

function generatePaletteChunks() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const labelsDir = resolve(scriptDir, '../src/lib/labels');
  const chunkCount = Math.ceil(SOURCE_SWATCHES.length / CHUNK_SIZE);

  for (let offset = 0; offset < chunkCount; offset += 1) {
    const startIndex = offset * CHUNK_SIZE;
    const chunkEntries = SOURCE_SWATCHES.slice(startIndex, startIndex + CHUNK_SIZE);
    const formattedEntries = chunkEntries.map((entry, entryOffset) =>
      formatSwatchEntry(entry, startIndex + entryOffset),
    );
    const chunkNumber = offset + FIRST_CHUNK_INDEX;
    const outputPath = resolve(labelsDir, `palette-swatches-${chunkNumber}.ts`);
    writeFileSync(outputPath, renderChunkModule(chunkNumber, formattedEntries), 'utf8');
  }
}

generatePaletteChunks();
