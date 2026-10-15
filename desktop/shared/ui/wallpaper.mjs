import { h } from './gui/sdk/js/reconciler.mjs';
const fill = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' };
const gradient = (from, to) => ({ backgroundColor: from, gradientFrom: from, gradientTo: to });
export function wallpaper(theme, id = 'appearance-wallpaper', asset = '') {
  const art = asset ? [h('view', { style: { ...fill, backgroundImage: asset } })] :
    theme.desktop.layers.map(layer => h('view', { style: {
      position: 'absolute', left: layer.left, top: layer.top, width: layer.width, height: layer.height,
      borderRadius: layer.radius, rotate: layer.rotation, opacity: layer.opacity,
      borderWidth: layer.borderWidth, borderColor: layer.borderColor, ...gradient(layer.from, layer.to),
    } }));
  return h('view', { id,
    style: { ...fill, ...gradient(theme.desktop.from, theme.desktop.to), overflow: 'hidden' } }, art);
}
