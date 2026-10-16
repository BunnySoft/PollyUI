import { getDesktopTheme, DEFAULT_DESKTOP_THEME } from './desktop/shared/ui/themes.mjs';
import { createWallpaperMaterial } from './desktop/shared/ui/material.mjs';
import { createMaterialSource } from './desktop/shell/material-source.mjs';
import { parseMaterialSource } from './desktop/client/settings-contract.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const theme = getDesktopTheme(DEFAULT_DESKTOP_THEME);
const fixture = document.createElement('canvas'); fixture.width = 160; fixture.height = 96;
const ink = fixture.getContext('2d');
ink.fillStyle = '#ff0000'; ink.fillRect(0, 0, 80, 96);
ink.fillStyle = '#0000ff'; ink.fillRect(80, 0, 80, 96);
const blob = await new Promise(resolve => fixture.toBlob(resolve));
const bitmap = createBitmap(await blob.arrayBuffer(), 160 * 96);
let projected = 0;
const projection = createMaterialSource({ document: () => document,
  bitmap: key => { check(key === bitmap.key, 'Projection only receives the committed owned bitmap key'); projected++; return bitmap; } });
const current = { themeId: theme.id, revision: 1, asset: bitmap.key };
const dto = parseMaterialSource(JSON.stringify({ ...projection.read(current), generation: 1 }));
check(dto.width <= 128 && dto.height <= 128 && dto.dataURL.length <= 128 * 1024, 'Real bitmap preview is bounded');
check(projection.read(current).dataURL === dto.dataURL && projected === 1, 'Unchanged projection does no bitmap read or PNG encode');
const asset = dto.dataURL;
const errors = [], material = createWallpaperMaterial({ onError: error => errors.push(error.message) });
const value = { theme, width: 160, height: 96, blur: 12, asset };
const pixel = (x, y) => [...material.canvas.getContext('2d').getImageData(x, y, 1, 1).data];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
try {
  check(await material.update(value), 'Initial material commits');
  const left = pixel(12, 48), middle = pixel(80, 48), right = pixel(148, 48);
  check(left[0] > right[0] + 20 && right[2] > left[2] + 20 &&
    middle[0] > right[0] + 5 && middle[2] > left[2] + 5,
  'Actual image-derived Gaussian transition survives tint; not solid fill or opacity');
  const data = material.canvas.getContext('2d').getImageData(0, 0, 160, 96).data;
  check([...data].every((v, i) => i % 4 !== 3 || v === 255), 'Every base pixel, including all edges, is opaque');
  check(same(pixel(0, 0), left) && same(pixel(159, 95), right), 'Clamped padding has no transparent/dark edge seam');
  Object.assign(material.canvas.style, { position: 'absolute', left: '0', top: '0' });
  document.body.appendChild(material.canvas);
  const foreground = document.createElement('view');
  Object.assign(foreground.style, { position: 'absolute', left: '20', top: '20', width: '40', height: '4',
    backgroundColor: '#000000' });
  document.body.appendChild(foreground);
  host.render(); host.render();
  check(host.pixel(21, 21) === '#000000' && host.pixel(21, 19) !== '#000000',
    'Foreground sibling remains sharp and opaque in actual DOM composition');
  const cached = material.stats;
  for (let i = 0; i < 8; ++i) {
    host.render();
    check(await material.update(value) === false, 'Unchanged update reuses texture');
  }
  check(same(cached, material.stats), 'Unchanged repaints perform no read/decode/blur/composite');
  await material.update({ ...value, active: false });
  check(material.stats.blurs === 1 && material.stats.decodes === 1 && !same(pixel(12, 48), left),
    'Activation updates tint without decoding or blurring again');
  await material.update({ ...value, width: 200 });
  check(material.stats.blurs === 2 && material.stats.decodes === 1, 'Resize updates real cached texture');
  await material.update({ ...value, scale: 2 });
  check(material.stats.blurs === 3 && material.canvas.width > 160, 'Explicit scale changes backing sampling');
  await material.update({ ...value, sourceRevision: 1 });
  check(material.stats.decodes === 2 && material.stats.blurs === 4, 'Same-path source revision reloads');
  await material.update({ ...value, asset: '', theme: { ...theme, desktop: { ...theme.desktop,
    from: '#008000', to: '#008000', layers: [] } } });
  const green = pixel(12, 48);
  check(green[1] > green[0] && green[1] > green[2], 'Actual theme-derived pixels replace image source');
  await material.update({ ...value, asset: '', theme: { ...theme, desktop: { ...theme.desktop,
    from: '#000000', to: '#000000', layers: [{ left: '50%', top: 0, width: '50%', height: '100%',
      radius: 0, rotation: 0, opacity: 1, borderWidth: 0, borderColor: 'transparent',
      from: '#ffffff', to: '#ffffff' }] } } });
  check(pixel(148, 48)[0] > pixel(12, 48)[0] + 30 && pixel(80, 48)[0] > pixel(12, 48)[0] + 5,
    'Theme layer geometry is truly painted and filtered');
  await material.update({ ...value, width: 16384, height: 16384, scale: 8, blur: 64 });
  check(material.canvas.width * material.canvas.height <= material.stats.maxPixels, 'Pixel budget bounds huge requests');
  for (const [width, height] of [[1, 16384], [16384, 1], [1, 16384]]) {
    await material.update({ ...value, width, height, scale: 8, blur: 0 });
    check(material.canvas.width * material.canvas.height <= material.stats.maxPixels,
      'Extreme aspect changes never allocate the previous height times the next width');
  }
  let error;
  try { await material.update({ ...value, asset: 'missing-material-fixture.png' }); } catch (failure) { error = failure; }
  check(error?.name === 'EncodingError' && errors.length === 1 && !material.stats.ready && material.canvas.width === 0,
    'Real decode failure explicitly rejects and clears previous success');
  await material.update({ ...value, mode: 'solid' });
  const expected = theme.colors.body.slice(1).match(/../g).map(v => parseInt(v, 16)).concat(255);
  check(same(pixel(0, 0), expected), 'Explicit solid mode recovers original body color');
  console.log('MATERIAL_PIXELS ' + JSON.stringify({ left, middle, right, green, cached, final: material.stats,
    foregroundSharp: true, allOpaque: true, scale: 'explicit input; --test host remains 1.0' }));
} finally {
  material.dispose(); projection.close(); bitmap.close(); fixture.width = fixture.height = 0;
}
check(material.stats.disposed && material.canvas.width === 0 && material.canvas.height === 0,
  'Dispose releases published backing pixels');
console.log('PASS: real raster wallpaper material pixels, clamped edges, sharp foreground, cache, invalidation, errors and disposal');
{
  const original = document.createElement('canvas'); original.width = 4; original.height = 2;
  const ink = original.getContext('2d'); ink.fillStyle = '#ff0000'; ink.fillRect(0, 0, 2, 2);
  const blob = await new Promise(resolve => original.toBlob(resolve));
  const owned = createBitmap(await blob.arrayBuffer(), 8);
  const source = createMaterialSource({ document: () => document, bitmap: () => owned });
  const image = new Image(), output = document.createElement('canvas'); output.width = 4; output.height = 2;
  try {
    image.src = source.read({ themeId: theme.id, revision: 1, asset: owned.key }).dataURL;
    await image.decode(); output.getContext('2d').drawImage(image, 0, 0);
    check(output.getContext('2d').getImageData(3, 0, 1, 1).data[3] === 0 &&
      output.getContext('2d').getImageData(0, 0, 1, 1).data[3] === 255,
    'Read-only PNG projection preserves actual transparent and opaque bitmap alpha, without scene pixels');
  } finally { source.close(); owned.close(); image.removeAttribute('src'); original.width = output.width = 0; }
}
