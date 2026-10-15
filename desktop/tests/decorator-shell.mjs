import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { encodeDecorationLayout } from './desktop/shared/ui/caption-layout.mjs';

if (typeof desktop.decorationRequests !== 'undefined')
  throw new Error('Shell incorrectly received renderer APIs');
const theme = getDesktopTheme('xp');
desktop.configureAppearance(theme, encodeDecorationLayout(theme));
const surface = window.create({ title: 'Decorator.fixture.shell', width: 180, height: 80 });
surface.document.body.style.backgroundColor = '#345678';
surface.onclose = () => window.quit();
window.close();
