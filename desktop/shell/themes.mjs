// Original palettes and geometry inspired by desktop eras, not bundled OS assets.
export const DEFAULT_DESKTOP_THEME = 'xp';

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const DESKTOP_THEMES = freeze([
  {
    id: 'xp', name: 'XP / Luna', era: 'Bright blue chrome, green launcher, soft corners',
    desktop: { from: '#286bd3', to: '#b8e0f4', motif: 'hills', detail: '#49982f' },
    colors: {
      text: '#202638', muted: '#526074', surface: '#ffffff', body: '#ece9d8',
      border: '#7f9db9', accent: '#245edb', accentText: '#ffffff',
      selection: '#dce8fd', light: '#ffffff', dark: '#6d7790',
    },
    window: {
      radius: 8, border: '#1649ad', borderWidth: 3, titleHeight: 32,
      titleFrom: '#4396ff', titleTo: '#1252c9', titleText: '#ffffff',
      inactiveFrom: '#a8c3e9', inactiveTo: '#6e96cf', inactiveText: '#172d54',
      controls: 'right', controlShape: 'square', controlRadius: 4,
      controlFrom: '#82b9ff', controlTo: '#2862c9',
      closeFrom: '#f99b7d', closeTo: '#cf4628', controlText: '#ffffff',
      texture: 'none', shadow: 12,
    },
    button: { from: '#ffffff', to: '#e6e5da', radius: 4, gloss: false },
    panel: {
      kind: 'taskbar', from: '#4384ef', to: '#1549b9', text: '#ffffff',
      launcherFrom: '#6bac5d', launcherTo: '#28732c', launcherText: '#ffffff',
    },
  },
  {
    id: 'server2003', name: 'Server 2003 / Classic', era: 'Square frames, restrained gray, beveled controls',
    desktop: { from: '#396c79', to: '#396c79', motif: 'plain', detail: '#477f8d' },
    colors: {
      text: '#151515', muted: '#505050', surface: '#ffffff', body: '#d4d0c8',
      border: '#808080', accent: '#0a246a', accentText: '#ffffff',
      selection: '#dce2ee', light: '#ffffff', dark: '#62615e',
    },
    window: {
      radius: 0, border: '#74716b', borderWidth: 3, titleHeight: 27,
      titleFrom: '#0a246a', titleTo: '#a6c8df', titleText: '#ffffff',
      inactiveFrom: '#7e7d79', inactiveTo: '#c5c3bc', inactiveText: '#ffffff',
      controls: 'right', controlShape: 'square', controlRadius: 0,
      controlFrom: '#eeebe5', controlTo: '#bbb8b0',
      closeFrom: '#eeebe5', closeTo: '#bbb8b0', controlText: '#151515',
      texture: 'none', shadow: 0,
    },
    button: { from: '#e9e6df', to: '#d4d0c8', radius: 0, gloss: false },
    panel: {
      kind: 'taskbar', from: '#e9e6df', to: '#d4d0c8', text: '#151515',
      launcherFrom: '#e9e6df', launcherTo: '#d4d0c8', launcherText: '#151515',
    },
  },
  {
    id: 'aqua', name: 'OS X / Aqua', era: 'Pinstripes, translucent-looking blues, glossy controls',
    desktop: { from: '#105494', to: '#78bcd8', motif: 'ribbons', detail: '#b3e8f0' },
    colors: {
      text: '#202934', muted: '#526777', surface: '#ffffff', body: '#eef2f5',
      border: '#91a5b6', accent: '#1667c5', accentText: '#ffffff',
      selection: '#cfe7fb', light: '#ffffff', dark: '#6b8193',
    },
    window: {
      radius: 10, border: '#7b91a4', borderWidth: 1, titleHeight: 32,
      titleFrom: '#ffffff', titleTo: '#d9e2e9', titleText: '#202934',
      inactiveFrom: '#f4f6f8', inactiveTo: '#e9edf0', inactiveText: '#667584',
      controls: 'left', controlShape: 'round', controlRadius: 8,
      controlFrom: '#ffffff', controlTo: '#d1dce6',
      closeFrom: '#ffb1a8', closeTo: '#d84b43', controlText: '#582c24',
      texture: 'pinstripe', shadow: 20,
    },
    button: { from: '#ffffff', to: '#bedcf5', radius: 13, gloss: true },
    panel: {
      kind: 'dock', from: '#f9fdff', to: '#b4d5e5', text: '#20354c',
      launcherFrom: '#ffffff', launcherTo: '#d4e7f3', launcherText: '#20354c',
    },
  },
  {
    id: 'lion', name: 'OS X / Lion', era: 'Graphite linen, brushed gray chrome, compact glass dock',
    desktop: { from: '#49515d', to: '#292f39', motif: 'linen', detail: '#626b78' },
    colors: {
      text: '#272b30', muted: '#626a73', surface: '#ffffff', body: '#e4e5e7',
      border: '#92969d', accent: '#397fba', accentText: '#ffffff',
      selection: '#d4e2ef', light: '#ffffff', dark: '#656b73',
    },
    window: {
      radius: 6, border: '#777d85', borderWidth: 1, titleHeight: 30,
      titleFrom: '#e6e7e9', titleTo: '#b7bbc0', titleText: '#2e333a',
      inactiveFrom: '#e5e6e8', inactiveTo: '#cfd1d5', inactiveText: '#68717c',
      controls: 'left', controlShape: 'round', controlRadius: 8,
      controlFrom: '#f4f5f7', controlTo: '#bfc4cb',
      closeFrom: '#f99c91', closeTo: '#c9564b', controlText: '#532822',
      texture: 'none', shadow: 18,
    },
    button: { from: '#fcfcfd', to: '#cdd1d6', radius: 5, gloss: false },
    panel: {
      kind: 'dock', from: '#d4d9df', to: '#7c8592', text: '#202a35',
      launcherFrom: '#eeeeef', launcherTo: '#b8bec7', launcherText: '#26323d',
    },
  },
]);

export function getDesktopTheme(id) {
  const theme = DESKTOP_THEMES.find(candidate => candidate.id === id);
  if (!theme) throw new RangeError('Unknown desktop appearance: ' + String(id));
  return theme;
}
