import { createDesktopIconResources } from './desktop/shell/desktop-icon-resources.mjs';
const { root, alternate } = desktopIconFixture;
function check(value, message) { if (!value) throw new Error(message); console.log('PASS: ' + message); }
const bitmaps = [];
const resources = createDesktopIconResources((bytes, maximum) => {
  const bitmap = createBitmap(bytes, maximum); bitmaps.push(bitmap); return bitmap;
});
const entry = { id: 'bundle:org.pollyui.icon-fixture', path: root, icon: root + '/icon.png' };
const key = resources.load(entry);
check(key.startsWith('polly-memory:') && bitmaps[0].width === 32, 'registered bundle bytes use the actual bounded GUI bitmap decoder');
check(resources.load(entry) === key && bitmaps.length === 1, 'repaint reuses live bundle bitmap');
resources.retain([entry]);
check(!bitmaps[0].closed, 'pin retention preserves a live bitmap');
resources.retain([]);
check(bitmaps[0].closed, 'unpin releases decoded bitmap ownership immediately');
const updated = { ...entry, path: alternate, icon: alternate + '/icon.png' };
resources.load(entry);
resources.retain([updated]);
check(bitmaps[1].closed, 'catalog object-path change retires old artwork');
resources.load(updated);
check(!bitmaps[2].closed, 'replacement bundle icon has independent ownership');
for (const icon of [root + '/invalid.png', root + '/link.png', root + '/oversized.png']) {
  let failure = null;
  try { resources.load({ ...entry, icon }); } catch (error) { failure = error; }
  check(failure !== null, 'invalid, symlink or oversized bitmap fails explicitly: ' + icon.slice(root.length + 1));
}
resources.close();
check(bitmaps[2].closed, 'Shell teardown releases all remaining icon bitmaps');
const direct = { ...entry, id: 'absolute-icon.desktop' };
resources.load(direct);
check(bitmaps.length === 4 && !bitmaps[3].closed, 'absolute desktop-entry PNG uses existing bitmap pipeline without an icon-name resolver');
resources.close();
check(bitmaps[3].closed, 'absolute desktop-entry bitmap is also released');
