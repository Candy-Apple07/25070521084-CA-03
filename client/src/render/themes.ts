export interface TableTheme {
  id: string;
  name: string;
  cloth: string;
  clothLight: string;
  cushion: string;
  rail: string;
  railLight: string;
  railDark: string;
  trim: string;
  lines: string;
}

export const TABLE_THEMES: TableTheme[] = [
  { id: 'championship', name: 'Championship green', cloth: '#1f6b3c', clothLight: '#2f8a52', cushion: '#175632', rail: '#5b2a17', railLight: '#7d4126', railDark: '#2f140a', trim: '#c9a55c', lines: 'rgba(255,255,255,0.55)' },
  { id: 'tournament', name: 'Tournament blue', cloth: '#1d4f86', clothLight: '#2c69a8', cushion: '#163f6c', rail: '#3d2618', railLight: '#5a3a24', railDark: '#1f120a', trim: '#d6dbe0', lines: 'rgba(255,255,255,0.5)' },
  { id: 'claret', name: 'Claret', cloth: '#7a1d2b', clothLight: '#9a2c3c', cushion: '#621621', rail: '#1f1714', railLight: '#3a2c26', railDark: '#0c0807', trim: '#c9a55c', lines: 'rgba(255,240,220,0.5)' },
  { id: 'plum', name: 'Plum velvet', cloth: '#4a2a66', clothLight: '#643b88', cushion: '#3a2052', rail: '#4d2016', railLight: '#6c3324', railDark: '#260d08', trim: '#e0c07a', lines: 'rgba(255,255,255,0.45)' },
  { id: 'slate', name: 'Slate', cloth: '#4b5963', clothLight: '#62727e', cushion: '#3c4850', rail: '#b08a5c', railLight: '#cfa978', railDark: '#7a5a35', trim: '#2b2b2b', lines: 'rgba(255,255,255,0.55)' },
  { id: 'saffron', name: 'Saffron', cloth: '#b5602a', clothLight: '#cf7a3d', cushion: '#954d20', rail: '#2a1c14', railLight: '#46301f', railDark: '#120b07', trim: '#f2d7a6', lines: 'rgba(255,250,235,0.6)' },
  { id: 'midnight', name: 'Midnight neon', cloth: '#14203a', clothLight: '#1f3157', cushion: '#0f182c', rail: '#0d0f16', railLight: '#1f2433', railDark: '#05060a', trim: '#38e1ff', lines: 'rgba(56,225,255,0.55)' },
];

export function tableTheme(id: string): TableTheme {
  return TABLE_THEMES.find((t) => t.id === id) ?? TABLE_THEMES[0];
}

export interface CueSkin {
  id: string;
  name: string;
  shaft: string;
  butt: string;
  buttDark: string;
  inlay: string;
  /** Optional stripe colour drawn over the butt. */
  stripe?: string;
  glow?: string;
}

export const CUE_SKINS: CueSkin[] = [
  { id: 'maple', name: 'Club maple', shaft: '#e7cc95', butt: '#4a2614', buttDark: '#2a140a', inlay: '#c9a55c' },
  { id: 'ebony', name: 'Ebony', shaft: '#ead39f', butt: '#1b1715', buttDark: '#050404', inlay: '#d6dbe0' },
  { id: 'tiger', name: 'Tiger', shaft: '#e9cf98', butt: '#c4661c', buttDark: '#7a3a0c', inlay: '#151515', stripe: '#1b1209' },
  { id: 'candy', name: 'Candy', shaft: '#f3e2bd', butt: '#f4a6c4', buttDark: '#c45d87', inlay: '#ffffff', stripe: '#ffffff' },
  { id: 'ivory', name: 'Ivory', shaft: '#ecd8ad', butt: '#efe4cf', buttDark: '#b9a888', inlay: '#a3262a' },
  { id: 'carbon', name: 'Carbon', shaft: '#d9c08c', butt: '#2a2d33', buttDark: '#121418', inlay: '#e0383e' },
  { id: 'neon', name: 'Neon', shaft: '#dfe9f2', butt: '#11131c', buttDark: '#05060a', inlay: '#38e1ff', glow: '#38e1ff' },
];

export function cueSkin(id: string): CueSkin {
  return CUE_SKINS.find((c) => c.id === id) ?? CUE_SKINS[0];
}

export const BALL_COLORS: Record<string, { base: string; light: string; dark: string; label: string; ink: string }> = {
  cue: { base: '#f1ead8', light: '#ffffff', dark: '#b9ae95', label: '', ink: '#000' },
  red: { base: '#b3121b', light: '#ff5a4e', dark: '#4a0306', label: '1', ink: '#fff' },
  yellow: { base: '#e9c21b', light: '#fff27a', dark: '#7d5f00', label: '2', ink: '#1a1200' },
  green: { base: '#0f7a3c', light: '#4fd07e', dark: '#03361a', label: '3', ink: '#fff' },
  brown: { base: '#6b3a1c', light: '#b57446', dark: '#2a1205', label: '4', ink: '#fff' },
  blue: { base: '#1347b5', light: '#5e93ff', dark: '#041a4f', label: '5', ink: '#fff' },
  pink: { base: '#ee7fa6', light: '#ffc6da', dark: '#8c3456', label: '6', ink: '#3a0b1d' },
  black: { base: '#17161a', light: '#6b6a72', dark: '#000000', label: '7', ink: '#fff' },
};

/** Pool ball colours by number; 9-15 reuse 1-7 as stripes. */
export const POOL_COLORS: Record<number, string> = {
  1: '#f2c014', 2: '#1d4fc0', 3: '#d42a2a', 4: '#5d2b8f', 5: '#f0701c', 6: '#13804a', 7: '#7c2020', 8: '#121212',
};

export function poolColor(n: number): string {
  return POOL_COLORS[n > 8 ? n - 8 : n];
}

export const AVATARS = ['🦊', '🐼', '🦉', '🐯', '🐸', '🐙', '🦄', '🐻', '🐧', '🦁', '🐨', '🐲', '🦩', '🐺', '🦔', '🐳'];
