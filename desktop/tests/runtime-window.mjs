import { createAppearancePreview } from './desktop/shell/appearance.mjs';
import { DESKTOP_THEMES } from './desktop/shell/themes.mjs';

if (window.platform !== 'linux') throw new Error('This integration fixture requires the Linux host');
const preview = createAppearancePreview().mount(document.body);
let index = 0;
function next() {
  if (index === DESKTOP_THEMES.length) {
    console.log('PollyUI runtime theme cycle complete');
    window.close();
    return;
  }
  const id = DESKTOP_THEMES[index++].id;
  preview.selectTheme(id);
  console.log('PollyUI runtime theme: ' + id);
  setTimeout(next, 250);
}
setTimeout(next, 250);
