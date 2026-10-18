// Generic layout/paint regression: no theme, application or compositor behavior.
const el = (style, parent) => {
  const node = document.createElement('view');
  Object.assign(node.style, style);
  parent.appendChild(node);
  return node;
};
const check = (condition, message) => { if (!condition) throw new Error(message); };
const rect = node => {
  const r = node.getBoundingClientRect();
  return [r.x, r.y, r.width, r.height];
};
const coherent = globalThis.expectCoherentLayout !== false;
for (const [name, style, contentHeight] of [
  ['integer', { left: 64, top: 86, width: 512, height: 374 }, 1000],
  ['fractional', { left: 64.4, top: 86.4, width: 512.4, height: 374.4 }, 1000],
  ['percent-max', { left: '10%', top: '18%', width: '80%', maxHeight: '78%' }, 1000],
  ['auto', { left: 8, top: 114.6, width: 404 }, 72.6],
]) {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  const viewport = el({ position: 'absolute', width: 640, height: 480, backgroundColor: '#ffffff' }, document.body);
  const parent = el({ position: 'absolute', overflow: 'hidden', backgroundColor: '#223344', ...style }, viewport);
  el({ height: contentHeight, flexShrink: 0 }, parent);
  const fill = el({ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }, parent);
  const bottom = el({ position: 'absolute', left: 0, right: 0, bottom: 0, height: 1,
    backgroundColor: '#ff0000' }, fill);
  const right = el({ position: 'absolute', right: 0, top: 0, bottom: 0, width: 1,
    backgroundColor: '#00ff00' }, fill);
  host.render();
  const [x, y, width, height] = rect(parent);
  check(JSON.stringify(rect(fill)) === JSON.stringify(rect(parent)), name + ': fill shares all rounded absolute edges');
  if (!coherent && name !== 'integer') {
    const expectedBottom = name === 'auto' ? 187 : 459;
    check(bottom.offsetTop === expectedBottom, name + ': legacy keeps original bottom placement');
    check(host.pixel(x + 8, y + height - 1) === '#223344', name + ': legacy keeps known inside-edge gap');
    check(host.pixel(x + 8, y + height) === '#FFFFFF', name + ': legacy retains original clip');
    console.log('PASS: legacy pixel-grid ' + name + ' ' +
      JSON.stringify({ parent: rect(parent), bottom: rect(bottom), right: rect(right) }));
    continue;
  }
  check(bottom.offsetTop + bottom.offsetHeight === y + height, name + ': bottom child shares parent bottom');
  check(right.offsetLeft + right.offsetWidth === x + width, name + ': right child shares parent right');
  check(host.pixel(x + 8, y + height - 1) === '#FF0000', name + ': bottom edge is actually painted inside clip');
  check(host.pixel(x + width - 1, y + 8) === '#00FF00', name + ': right edge is actually painted inside clip');
  check(host.pixel(x + 8, y + height) === '#FFFFFF', name + ': no paint escapes bottom clip');
  check(host.pixel(x + width, y + 8) === '#FFFFFF', name + ': no paint escapes right clip');
  if (name === 'integer')
    check(JSON.stringify(rect(parent)) === '[64,86,512,374]', 'Integer layout remains unchanged');
  console.log('PASS: generic pixel-grid ' + name + ' ' + JSON.stringify({ parent: rect(parent), bottom: rect(bottom), right: rect(right) }));
}
