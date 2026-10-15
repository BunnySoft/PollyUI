import { getDesktopTheme, DEFAULT_DESKTOP_THEME } from './desktop/shared/ui/themes.mjs';
import { createWallpaperMaterial } from './desktop/shared/ui/material.mjs';

const theme = getDesktopTheme(DEFAULT_DESKTOP_THEME);
const material = createWallpaperMaterial({ onError: error => {
  status.textContent = 'Material unavailable: ' + error.message;
  console.error('[material example]', error);
} });
const status = document.createElement('view'), toggle = document.createElement('view');
const foreground = document.createElement('view');
status.id = 'material-status'; toggle.id = 'material-toggle'; foreground.id = 'material-foreground';
let mode = 'wallpaper', stopped = false;
Object.assign(document.body.style, { backgroundColor: theme.colors.body });
Object.assign(material.canvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' });
material.canvas.setAttribute('aria-hidden', 'true');
document.body.appendChild(material.canvas);
Object.assign(foreground.style, { padding: '32', gap: '16', color: theme.colors.text });
foreground.textContent = 'Wallpaper-derived opaque client base (not live Acrylic or native DWM Mica)';
Object.assign(toggle.style, { padding: '12', backgroundColor: theme.colors.surface, borderWidth: '1',
  borderColor: theme.colors.border, borderRadius: '8' });
toggle.setAttribute('role', 'button'); toggle.tabIndex = 0;
foreground.appendChild(toggle); foreground.appendChild(status); document.body.appendChild(foreground);
function update(state = window.state) {
  if (stopped || state.width < 1 || state.height < 1) return;
  toggle.textContent = mode === 'wallpaper' ? 'Restore solid client base' : 'Enable wallpaper material';
  return material.update({ theme, mode, width: state.width, height: state.height,
    scale: state.scale, active: state.active }).then(changed => {
    if (changed && !stopped) status.textContent = 'Cached: ' + JSON.stringify(material.stats);
  });
}
function showError(error) { status.textContent = 'Material unavailable: ' + error.message; }
function activate() { mode = mode === 'wallpaper' ? 'solid' : 'wallpaper'; update().catch(showError); }
toggle.addEventListener('click', activate);
toggle.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
});
const unsubscribe = window.observeState(state => { update(state)?.catch(showError); });
window.onclose = () => { stopped = true; unsubscribe(); material.dispose(); };
await update();
