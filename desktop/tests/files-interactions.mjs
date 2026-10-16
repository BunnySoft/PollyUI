import { verticalScrollMetrics } from './gui/sdk/js/scrollbar.mjs';

export const interactionStages = flow => flow === 'text' ?
  ['text-selection', 'text-focus-restored', 'before-wm-close'] :
  flow === 'text-lifecycle' ? ['text-address-long', 'text-focus-restored', 'before-wm-close'] :
  ['scrollbar-top', 'scrollbar-bottom', 'before-wm-close'];
export const interactionEvidence = flow => Object.fromEntries((flow === 'text' ?
  ['capture', 'outsideMotion', 'release', 'shiftSelection', 'focus', 'cursor', 'focusCancel', 'closeCancel'] :
  flow === 'text-lifecycle' ? ['capture', 'focus', 'cursor', 'horizontalScroll', 'detach', 'focusCancel', 'closeCancel'] :
  ['capture', 'outsideMotion', 'release', 'page', 'keyboard', 'wheelSync', 'bounds', 'metadata', 'detach', 'focusCancel', 'closeCancel'])
  .map(key => [key, false]));

// Actions go exclusively through the shared native Wayland driver. Event observers
// paint a tiny non-hit-testable acknowledgement; they never acquire capture or edit.
export async function runFilesInteractions({ app, flow, evidence, samples, until, request, click, wheel, captureFrame, close }) {
  const surface = app.getWindow(), doc = surface.document;
  const cursors = [], nativeCursor = surface.setCursor;
  surface.setCursor = name => { nativeCursor.call(surface, name); cursors.push(name); };
  const node = id => doc.getElementById('files-' + id);
  const state = () => app.controller.getState();
  const rect = value => value.getBoundingClientRect();
  const check = (name, condition, data = {}) => {
    samples.push({ name, passed: !!condition, ...data });
    if (!condition) throw new Error('Native Files interaction failed: ' + name + ' ' + JSON.stringify(data));
    console.log('FILES_INTERACTION: ' + JSON.stringify(samples[samples.length - 1]));
  };
  let feedback = null, observed = null, observers = [], events = [];
  function unwatch() {
    for (const [type, callback] of observers) observed.removeEventListener(type, callback);
    observers = [];
    feedback?.parentNode?.removeChild(feedback); feedback = null;
  }
  function watch(target, x, y) {
    unwatch();
    feedback = doc.createElement('view');
    Object.assign(feedback.style, { position: 'absolute', left: x - 3, top: y - 3, width: 6, height: 6,
      backgroundColor: '#808080', pointerEvents: 'none', zIndex: 100 });
    doc.body.appendChild(feedback);
    observed = target; events = [];
    for (const type of ['mousedown', 'mousemove', 'mouseup', 'mousecancel', 'lostmousecapture']) {
      const callback = event => {
        const record = { type, x: event.clientX, y: event.clientY, buttons: event.buttons, reason: event.reason };
        events.push(record);
        if (type === 'mousedown') {
          check('production widget acquired native capture', target.hasMouseCapture(), record);
          evidence.capture = true; feedback.style.backgroundColor = '#c04020';
        } else if (type === 'mousemove' && event.buttons === 1) {
          check('captured native motion', target.hasMouseCapture(), record);
          if (event.clientX > doc.body.offsetWidth) evidence.outsideMotion = true;
          feedback.style.backgroundColor = '#20c040';
        } else if (type === 'mouseup') {
          evidence.release = true; feedback.style.backgroundColor = '#3060c0';
        } else if (type === 'mousecancel') {
          if (event.reason === 'node-detached') evidence.detach = true;
          if (event.reason === 'focus-lost') evidence.focusCancel = true;
          if (event.reason === 'window-closed') evidence.closeCancel = true;
          feedback.style.backgroundColor = '#3060c0';
          samples.push({ name: 'native cancellation', passed: true, ...record });
        } else if (type === 'lostmousecapture') {
          feedback.style.backgroundColor = '#3060c0';
        }
      };
      target.addEventListener(type, callback); observers.push([type, callback]);
    }
  }
  async function gesture(target, x, y, endX, endY) {
    watch(target, x, y);
    await request(`gesture ${x} ${y} ${endX} ${endY}`);
    await until(() => events.some(event => event.type === 'mouseup') && !target.hasMouseCapture(), 'real drag release');
    check('native drag down/move/up order and final release',
      events.findIndex(event => event.type === 'mousedown') < events.findIndex(event => event.type === 'mousemove' && event.buttons === 1) &&
      events.findIndex(event => event.type === 'mousemove' && event.buttons === 1) < events.findIndex(event => event.type === 'mouseup') &&
      events.some(event => event.type === 'lostmousecapture'), { events });
    unwatch();
  }
  async function cancel(target, action, code = '') {
    const bounds = rect(target);
    const thumb = flow === 'scrollbar' ? rect(node('scroll-thumb')) : null;
    const x = Math.round(bounds.x + (thumb ? bounds.width / 2 : 12));
    const y = Math.round(thumb ? thumb.y + thumb.height / 2 : bounds.y + bounds.height / 2);
    watch(target, x, y);
    await request(`${action} ${x} ${y}${code ? ' ' + code : ''}`);
    await until(() => events.some(event => event.type === 'mousecancel' || event.type === 'lostmousecapture'), 'real cancellation');
    if (action !== 'pressclose' && action !== 'presskey') check('cancelled capture is not resurrected', !target.hasMouseCapture());
    unwatch();
  }
  async function copy(expected) {
    await request('keycode 46 2');
    const text = clipboard.readText();
    check('native keyboard clipboard selection', text === expected, { expected, text });
  }
  function finish() {
    check('all pre-close native interaction evidence observed',
      Object.entries(evidence).every(([key, value]) => key === 'closeCancel' || value), { evidence });
    console.log('FILES_WINDOW_DRIVE_PASS: native Files ' + flow + ' captured interaction; closing with active capture');
    close();
  }
  const list = node('list');
  await until(() => node('filter').offsetWidth > 0 && list.offsetHeight > 0, 'actual Files control layout');
  if (flow === 'text') {
    await until(() => node('filter').offsetWidth > 0, 'actual filter layout');
    const first = rect(node('filter'));
    watch(node('filter'), Math.round(first.x + first.width / 2), Math.round(first.y + first.height / 2));
    await click('files-filter');
    check('same-batch native plain click acquired and released capture', events.some(event => event.type === 'mousedown') &&
      events.some(event => event.type === 'mouseup') && events.some(event => event.type === 'lostmousecapture') && !node('filter').hasMouseCapture(), { events });
    check('deferred list focus did not steal an actual filter click', doc.activeElement === node('filter'));
    unwatch();
    clipboard.writeText('row');
    await request('keycode 47 2');
    await until(() => state().filter === 'row', 'native paste filters loaded names');
    const field = node('filter'), bounds = rect(field);
    const x = Math.round(bounds.x + 9 + measureText('r', 14)), y = Math.round(bounds.y + bounds.height / 2);
    await gesture(field, x, y, doc.body.offsetWidth + 12, y);
    await copy('ow');
    await captureFrame('text-selection');
    await request('key backspace');
    await until(() => state().filter === 'r', 'native edit replaces captured selection');
    clipboard.writeText('ow');
    await request('keycode 47 2');
    await until(() => state().filter === 'row', 'restore filter through native paste');
    await request('keycode 105 1'); // Shift Left
    await copy('w');
    await request('keycode 102 1'); // Shift Home
    await copy('row');
    await request('keycode 106 0'); // Right collapses selection
    await request('key backspace');
    await until(() => state().filter === 'ro', 'plain Right collapses to selection end');
    evidence.shiftSelection = true;
    check('input focus survives selection edits', doc.activeElement === field);
    evidence.focus = true;
    check('Files input has themed focus feedback', field.style['focus:borderColor'].length > 0);
    await cancel(field, 'pressfocus');
    await until(() => evidence.focusCancel, 'actual native focus-loss cancellation');
    await click('files-filter');
    check('deactivation kept window-local keyboard focus usable', doc.activeElement === field);
    await captureFrame('text-focus-restored');
    check('widget hover and cancellation used actual native text/arrow cursors', cursors.includes('text') && cursors.includes('arrow'), { cursors });
    evidence.cursor = true;
    await captureFrame('before-wm-close');
    finish();
    await cancel(node('filter'), 'pressclose');
  } else if (flow === 'text-lifecycle') {
    check('initial ready Files keyboard focus belongs to its list', doc.activeElement === list);
    await request('keycode 38 2'); // Ctrl L
    await until(() => state().address !== null && doc.activeElement === node('address'), 'native address focus');
    evidence.focus = true;
    const address = node('address');
    clipboard.writeText(state().path + '/' + 'long-segment-'.repeat(30));
    await request('keycode 47 2');
    await until(() => Number(address.scrollLeft) > 0, 'long native address caret is visible');
    const endScroll = Number(address.scrollLeft);
    await request('keycode 102 0');
    check('Home reveals address start', Number(address.scrollLeft) === 0);
    await request('keycode 107 0');
    check('End reveals address end', Number(address.scrollLeft) > 0, { endScroll, scrollLeft: Number(address.scrollLeft) });
    evidence.horizontalScroll = true;
    await captureFrame('text-address-long');
    await cancel(address, 'presskey', '1 0'); // Escape removes the actual address input.
    await until(() => state().address === null && evidence.detach, 'captured address detach via native Escape');
    check('retired raw address input is removed, not retained in reused breadcrumbs', !node('address'));
    await click('files-filter');
    await cancel(node('filter'), 'pressfocus');
    await until(() => evidence.focusCancel, 'native input focus-loss cancellation');
    await click('files-filter');
    await captureFrame('text-focus-restored');
    check('widget hover and cancellation used actual native text/arrow cursors', cursors.includes('text') && cursors.includes('arrow'), { cursors });
    evidence.cursor = true;
    await captureFrame('before-wm-close');
    finish();
    await cancel(node('filter'), 'pressclose');
  } else {
    await until(() => Number(node('scrollbar').getAttribute('aria-valuemax')) > 0, 'actual laid-out scrollbar');
    const track = node('scrollbar'), width = list.offsetWidth;
    const rows = list.childNodes.map(row => ({ width: row.offsetWidth, columns: row.childNodes.map(child => child.offsetWidth) }));
    check('overlay rail leaves the list and all four metadata columns unchanged',
      list.offsetWidth === node('columns').offsetWidth && rows.every(row =>
        row.width === width - 8 && row.columns.length === 4 &&
        Math.abs(row.columns.reduce((sum, value) => sum + value, 0) - row.width) <= 2),
      { listWidth: width, columnHeaderWidth: node('columns').offsetWidth, railWidth: track.offsetWidth, first: rows[0] });
    evidence.metadata = true;
    await captureFrame('scrollbar-top');
    const bounds = rect(track), thumb = rect(node('scroll-thumb'));
    await gesture(track, Math.round(bounds.x + bounds.width / 2), Math.round(thumb.y + thumb.height / 2),
      doc.body.offsetWidth + 12, Math.round(bounds.y + bounds.height + 12));
    const arrow = track.querySelector('.scrollbar-decrement');
    const inset = arrow ? arrow.offsetHeight : 0;
    let metrics = verticalScrollMetrics(list, track.offsetHeight, { startInset: inset, endInset: inset });
    check('outside drag reaches actual list bottom', metrics.value === metrics.maximum &&
      Math.abs(Number(node('scroll-thumb').style.top) - metrics.top) < 0.1, metrics);
    evidence.bounds = true;
    await captureFrame('scrollbar-bottom');
    await request('keycode 102 0');
    check('scrollbar Home clamps to top', Number(list.scrollTop) === 0);
    await request('keycode 109 0'); // PageDown
    check('scrollbar PageDown uses actual viewport', Math.abs(Number(list.scrollTop) - list.offsetHeight) < 0.1);
    evidence.keyboard = true;
    await request('keycode 102 0');
    const lower = rect(track);
    await request('click ' + Math.round(lower.x + lower.width / 2) + ' ' + Math.round(lower.y + lower.height - inset - 2));
    check('native track press pages exactly one viewport', Math.abs(Number(list.scrollTop) - list.offsetHeight) < 0.1);
    evidence.page = true;
    await wheel(180);
    await until(() => Math.abs(Number(track.getAttribute('aria-valuenow')) - Number(list.scrollTop)) < 0.1, 'wheel updates real thumb');
    evidence.wheelSync = true;
    await request('keycode 102 0');
    await cancel(track, 'pressfocus');
    await until(() => evidence.focusCancel, 'actual scrollbar native focus cancellation');
    await click('files-entry-0');
    await until(() => state().selection !== null, 'native row selection before inline rename');
    await cancel(node('scrollbar'), 'presskey', '60 0'); // F2 changes layout and retires the old rail.
    await until(() => state().dialog?.kind === 'rename' && evidence.detach, 'native captured rail detach');
    await request('key escape');
    await until(() => !state().dialog, 'cancel rename without a filesystem mutation');
    await until(() => node('scrollbar').style.pointerEvents === 'auto', 'fresh actual rail is usable');
    await captureFrame('before-wm-close');
    finish();
    await cancel(node('scrollbar'), 'pressclose');
  }
  check('all required native interaction evidence observed', Object.values(evidence).every(Boolean), { evidence });
}
