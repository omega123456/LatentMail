/** Preset color swatches shown in the ColorPickerComponent's palette row. */
export interface LabelColor {
  name: string;
  hex: string;
}

export const LABEL_PRESET_COLORS: LabelColor[] = [
  { name: 'Red',    hex: '#D32F2F' },
  { name: 'Orange', hex: '#F57C00' },
  { name: 'Amber',  hex: '#FBC02D' },
  { name: 'Green',  hex: '#388E3C' },
  { name: 'Teal',   hex: '#00897B' },
  { name: 'Cyan',   hex: '#0097A7' },
  { name: 'Blue',   hex: '#1976D2' },
  { name: 'Indigo', hex: '#3949AB' },
  { name: 'Purple', hex: '#7B1FA2' },
  { name: 'Pink',   hex: '#C2185B' },
  { name: 'Brown',  hex: '#5D4037' },
  { name: 'Slate',  hex: '#607D8B' },
];

/** Default fallback color used when a label has no assigned color. */
export const DEFAULT_LABEL_COLOR = '#607D8B';
