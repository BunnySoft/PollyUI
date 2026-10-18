if (typeof decoration !== 'undefined') {
  if (typeof window !== 'undefined' || document.defaultView !== null)
    throw new Error('Frame policy probe must use the independent windowless renderer');
  const submit = decoration.submitDecorationFrame;
  let probed = false;
  const check = (value, message) => {
    if (!value) throw new Error(message);
    console.log('PASS: ' + message);
  };
  const rejects = (action, name, expected, message) => {
    let error = null;
    try { action(); } catch (failure) { error = failure; }
    check(error?.name === name && error.message === expected,
      error?.name === name && error.message === expected ? message : message + ' (actual rejection: ' + String(error) + ')');
  };
  decoration.submitDecorationFrame = (meta, strips) => {
    if (probed) return submit(meta, strips);
    rejects(() => submit(meta, [{ ...strips[0], width: strips[0].width + 1 }, ...strips.slice(1)]),
      'TypeError', 'Four exact RGBA strip images are required', 'renderer bridge rejects an inexact strip before transport');
    const obsolete = [...meta]; obsolete[1]++;
    check(submit(obsolete, strips) === false, 'renderer role rejects an unknown frame revision');
    const mismatched = [...meta]; mismatched[2]++;
    rejects(() => submit(mismatched, strips), 'InternalError',
      'GUI frame rejected: Invalid, unsealed, oversized or unallocatable frame',
      'renderer role rejects a complete frame with a mismatched theme generation');
    const accepted = submit(meta, strips);
    check(accepted, 'renderer role publishes the valid frame after all rejected submissions');
    check(submit(meta, strips) === false, 'renderer role rejects a duplicate accepted revision');
    probed = true;
    console.log('PASS: independent renderer completed all four frame submission negative cases');
    return accepted;
  };
  await import('./desktop/decorator/main.mjs');
} else {
  const app = window.create({ title: 'Decorator.fixture.app', width: 260, height: 160 });
  const target = app.document.createElement('view');
  Object.assign(target.style, { width: '100%', height: '100%', backgroundColor: '#234567' });
  target.addEventListener('click', () => { target.style.backgroundColor = '#33cc66'; });
  app.document.body.appendChild(target);
  app.onclose = () => window.quit();
  const frameless = window.create({ title: 'Decorator.fixture.frameless', width: 120, height: 60 });
  frameless.setFrameless(true);
  frameless.document.body.style.backgroundColor = '#654321';
  window.close();
}
