import { h, render } from './gui/sdk/js/reconciler.mjs';
import { createTextInput } from './gui/sdk/js/textinput.mjs';
import { requireFileSystem } from './desktop/apps/files/logic/model.mjs';
import { subscribeDesktopTheme } from './desktop/client/theme.mjs';
import { createFileDialogController } from './desktop/client/file-dialog-controller.mjs';

const owners = new WeakMap();
const descendants = node => [node, ...Array.from(node.childNodes || []).flatMap(descendants)];
let sequence = 0;
const row = { flexDirection: 'row', gap: 8, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' };

function palette(theme) {
  const color = (key, fallback) => /^#[0-9a-f]{6}$/i.test(theme?.colors?.[key]) ? theme.colors[key] : fallback;
  return { background: color('body', '#f5f7fa'), surface: color('surface', '#ffffff'),
    text: color('text', '#333639'), muted: color('muted', '#666a73'),
    border: color('border', '#cbd5e1'), accent: color('accent', '#2080f0'),
    focus: color('focus', '#2080f0'), error: '#b42318' };
}

// The modal belongs to one ordinary app document, never a Shell/layer surface.
export function showFileDialog({ parent = window, files,
  native = typeof desktop === 'undefined' ? null : desktop,
  optInTheme = false, settings = {}, notice = '',
  reportError = message => console.error('[file-dialog] ' + message) } = {}) {
  if (!parent?.document?.body || parent.closed) throw new Error('File dialog requires a live parent window');
  if (owners.has(parent)) throw new Error('This parent already owns a file dialog');
  const doc = parent.document, prefix = 'file-dialog-' + (++sequence);
  const previousFocus = doc.activeElement, previousClose = parent.onclose;
  let finished = false, themeBinding = null, theme = null, themeError = '';
  let unavailable = '';
  if (files === undefined) {
    try { files = requireFileSystem(native); }
    catch (error) { unavailable = String(error.message || error); reportError(unavailable); files = null; }
  }
  let resolve;
  const result = new Promise(done => { resolve = done; });
  const controller = createFileDialogController({ files, settings, initialError: unavailable,
    onChange: paint, onFinish: finish, reportError });
  const overlay = doc.createElement('view');
  overlay.id = prefix;
  Object.assign(overlay.style, { position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
    backgroundColor: '#00000060', padding: '12', justifyContent: 'center', alignItems: 'center' });
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', settings.mode === 'save' ? 'Save file' : 'Open file');
  const panel = doc.createElement('view');
  Object.assign(panel.style, { width: '100%', height: '100%', maxWidth: '800', maxHeight: '640',
    borderWidth: '1', borderRadius: '6', padding: '14', gap: '10' });
  const top = doc.createElement('view'), listing = doc.createElement('view'), bottom = doc.createElement('view');
  listing.id = prefix + '-list';
  Object.assign(listing.style, { flexGrow: '1', flexShrink: '1', minHeight: '60', overflow: 'scroll' });
  const locationRow = doc.createElement('view'), nameRow = doc.createElement('view');
  Object.assign(locationRow.style, { flexDirection: 'row', gap: '8', flexShrink: '0' });
  Object.assign(nameRow.style, { flexDirection: 'row', gap: '8', flexShrink: '0' });
  const location = createTextInput({ document: doc, width: '100%', fontSize: 14, padding: 8 });
  const filename = createTextInput({ document: doc, width: '100%', fontSize: 14, padding: 8 });
  location.root.id = prefix + '-location'; filename.root.id = prefix + '-name';
  location.root.setAttribute('aria-label', 'Directory location (Enter to navigate)');
  filename.root.setAttribute('aria-label', 'Filename');
  locationRow.appendChild(location.root); nameRow.appendChild(filename.root);
  panel.appendChild(top); panel.appendChild(locationRow); panel.appendChild(listing);
  if (controller.getState().mode === 'save') panel.appendChild(nameRow);
  panel.appendChild(bottom); overlay.appendChild(panel); doc.body.appendChild(overlay);
  owners.set(parent, controller);
  const onclose = () => {
    controller.cancel('parent-closed');
    if (typeof previousClose === 'function') previousClose.call(parent);
  };
  parent.onclose = onclose;
  let lastPath = '', lastPhase = '', page = 0, listRevision = -1;
  function controls() {
    const collect = node => node.style.display === 'none' ? [] :
      [...(node.tabIndex >= 0 ? [node] : []), ...Array.from(node.childNodes || []).flatMap(collect)];
    return collect(overlay);
  }
  function focus(id) { doc.getElementById(prefix + '-' + id)?.focus(); }
  function finish(value) {
    if (finished) return;
    finished = true;
    themeBinding?.stop();
    if (parent.onclose === onclose) parent.onclose = previousClose;
    owners.delete(parent);
    render(null, top); render(null, listing); render(null, bottom);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (!parent.closed && previousFocus && descendants(doc.body).includes(previousFocus)) previousFocus.focus();
    resolve(parent.closed && value.status === 'selected' ? { status: 'cancelled', reason: 'parent-closed' } : value);
  }
  function button(id, caption, action, enabled = true, selected = false) {
    const colors = palette(theme);
    const activate = event => {
      event.stopPropagation();
      if (!enabled || (event.button !== undefined && event.button !== 0)) return;
      return action();
    };
    return h('view', { id: prefix + '-' + id, tabIndex: enabled ? 0 : -1, role: 'button',
      'aria-label': caption, 'aria-disabled': String(!enabled), 'aria-pressed': String(selected),
      style: { borderWidth: 1, borderColor: selected ? colors.accent : colors.border,
        backgroundColor: colors.surface, color: enabled ? colors.text : colors.muted, opacity: enabled ? 1 : 0.5,
        borderRadius: 3, padding: 7, flexShrink: 0 },
      focusStyle: { borderColor: colors.focus }, hoverStyle: enabled ? { borderColor: colors.accent } : {},
      onClick: activate, onKeydown: event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); return activate(event); }
      } }, caption);
  }
  const label = (id, caption, color, size = 13) =>
    h('view', { id: prefix + '-' + id, style: { color, fontSize: size, flexShrink: 0 } }, caption);
  function paint() {
    if (finished || !overlay.parentNode || parent.closed) return;
    const state = controller.getState(), colors = palette(theme), revision = state.revision;
    panel.style.backgroundColor = colors.background; panel.style.borderColor = colors.border;
    const blocked = state.phase === 'overwrite', hasFiles = !!files;
    const usable = hasFiles && !blocked && !!state.directory &&
      !['idle', 'unavailable', 'error', 'loading'].includes(state.phase);
    for (const input of [location, filename]) {
      input.setAppearance({ color: colors.text, background: colors.surface,
        borderColor: colors.border, selectionColor: colors.accent });
      const enabled = hasFiles && !blocked && (input === location ? !!state.locations :
        ['ready', 'validating'].includes(state.phase));
      input.root.tabIndex = enabled ? 0 : -1;
      input.root.style.pointerEvents = enabled ? 'auto' : 'none';
    }
    if (state.directory && (lastPath !== state.directory.path || (lastPhase === 'loading' && state.phase !== 'loading'))) {
      if (lastPath !== state.directory.path) { listing.scrollTop = 0; page = 0; }
      lastPath = state.directory.path; location.value = lastPath;
    }
    if (filename.value !== state.name) filename.value = state.name;
    const breadcrumbs = [{ label: '/', path: '/' }];
    if (state.directory) {
      let path = '';
      for (const part of state.directory.path.split('/').filter(Boolean)) {
        path += '/' + part; breadcrumbs.push({ label: part, path });
      }
    }
    const shownBreadcrumbs = breadcrumbs.length > 6 ?
      [breadcrumbs[0], { label: '...', path: breadcrumbs[breadcrumbs.length - 5].path }, ...breadcrumbs.slice(-4)] :
      breadcrumbs;
    render(h('view', { style: { gap: 7, flexShrink: 0 } },
      label('title', state.mode === 'save' ? 'Save file' : 'Open file', colors.text, 20),
      h('view', { style: row },
        button('home', 'Home', () => controller.navigate(state.locations.home, revision), hasFiles && !!state.locations && !blocked),
        button('up', 'Up', () => controller.up(revision), usable && state.directory.path !== '/'),
        button('refresh', 'Refresh', () => state.directory ? controller.navigate(state.directory.path, revision) : controller.start(),
          hasFiles && !blocked && state.phase !== 'loading'),
        ...shownBreadcrumbs.map((item, index) => button('crumb-' + index, item.label,
          () => controller.navigate(item.path, revision), usable))),
      label('location-label', 'Location (absolute directory; press Enter)', colors.muted)), top);
    const entries = controller.visibleEntries(), pages = Math.max(1, Math.ceil(entries.length / 64));
    page = Math.min(page, pages - 1);
    listRevision++;
    const currentListRevision = listRevision;
    render(h('view', { style: { gap: 3, flexShrink: 0 } },
      state.phase === 'loading' ? label('loading', 'Loading directory...', colors.muted) : null,
      !entries.length && state.phase === 'ready' ? label('empty', 'No matching entries. No file is selected.', colors.muted) : null,
      ...entries.slice(page * 64, (page + 1) * 64).map((item, index) => {
        const selected = state.selection?.path === item.path;
        const caption = (item.type === 'directory' ? '[Folder] ' : item.type === 'symlink' ?
          '[Link -> ' + (item.targetType || 'unavailable') + '] ' : item.type === 'other' ? '[Other] ' : '[File] ') +
          item.name;
        return h('view', { style: { flexShrink: 0 } }, button('entry-' + index, caption,
          () => { if (currentListRevision === listRevision) controller.select(item.path, revision); },
          usable && item.type !== 'other', selected));
      })), listing);
    const primary = state.mode === 'save' ? 'Choose save target' :
      state.selection?.type === 'directory' || state.selection?.targetType === 'directory' ? 'Open folder' : 'Open';
    render(h('view', { style: { gap: 7, flexShrink: 0 } },
      !state.complete ? label('limited', 'Directory list limited to 1024 entries. Use Location to navigate; unlisted files are not selectable here.', colors.muted) : null,
      !blocked && pages > 1 ? h('view', { style: row },
        button('previous', 'Previous page', () => {
          if (currentListRevision !== listRevision) return;
          page--; listing.scrollTop = 0; paint(); focus('next');
        }, usable && page > 0),
        label('page', 'Page ' + (page + 1) + ' of ' + pages + ' (64 rows per page)', colors.muted),
        button('next', 'Next page', () => {
          if (currentListRevision !== listRevision) return;
          page++; listing.scrollTop = 0; paint(); focus('previous');
        }, usable && page + 1 < pages)) : null,
      h('view', { style: row }, ...state.filters.map((filter, index) => button('filter-' + index,
        filter.label, () => controller.setFilter(index, revision),
        hasFiles && !blocked && ['ready', 'validating'].includes(state.phase), state.filterIndex === index))),
      state.mode === 'save' ? label('name-label', 'Filename; chooser does not write content.', colors.muted) : null,
      state.selection ? label('selected', state.selection.path, colors.text) : label('selected', 'No file selected', colors.muted),
      state.phase === 'validating' ? label('pending', 'Checking the latest file and directory...', colors.muted) : null,
      state.error ? label('error', state.error, colors.error) : null,
      notice ? label('notice', notice, colors.error) : null,
      themeError ? label('theme-error', 'Theme error: ' + themeError, colors.error) : null,
      blocked ? h('view', { style: { gap: 7 } },
        label('overwrite-question', 'Replace existing file? ' + state.confirmation.path, colors.error, 16),
        label('overwrite-detail', 'Replacing discards this file content. Observation: ' +
          state.confirmation.target.identity + '. The consumer must use conditional writing.', colors.muted),
        h('view', { style: row },
          button('keep', 'Keep existing file', () => controller.dismissOverwrite(revision)),
          button('replace', 'Replace this file', () => controller.confirmOverwrite(revision)),
          button('cancel', 'Cancel', () => controller.cancel('cancelled', revision)))) :
        h('view', { style: row },
          button('accept', primary, () => controller.activate(revision),
            state.phase === 'ready' && (state.mode === 'open' ? !!state.selection : !!state.name || !!state.selection)),
          button('cancel', 'Cancel', () => controller.cancel('cancelled', revision)))), bottom);
    if (blocked) {
      listing.style.display = 'none'; locationRow.style.display = 'none'; nameRow.style.display = 'none';
    } else {
      listing.style.display = ''; locationRow.style.display = ''; nameRow.style.display = '';
    }
    if (lastPhase !== state.phase) {
      if (blocked) focus('keep');
      else if (state.phase === 'ready' && ['idle', 'loading'].includes(lastPhase))
        focus(state.mode === 'save' ? 'name' : entries.length ? 'entry-0' : 'cancel');
      lastPhase = state.phase;
    }
    const availableControls = controls();
    if (!availableControls.includes(doc.activeElement))
      (blocked ? doc.getElementById(prefix + '-keep') :
        state.mode === 'save' && usable ? filename.root : doc.getElementById(prefix + '-cancel'))?.focus();
  }
  location.root.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); event.stopPropagation();
    controller.navigate(location.value, controller.getState().revision);
  });
  function nameChanged() { controller.setName(filename.value, controller.getState().revision); }
  filename.root.addEventListener('textinput', nameChanged);
  filename.root.addEventListener('keydown', event => {
    if (['Backspace', 'Delete'].includes(event.key) ||
        ((event.ctrlKey || event.metaKey) && ['x', 'v'].includes(event.key.toLowerCase()))) nameChanged();
    if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation(); controller.activate(controller.getState().revision);
    }
  });
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); controller.cancel();
    } else if (event.key === 'Tab') {
      event.preventDefault(); event.stopPropagation();
      const nodes = controls(), index = nodes.indexOf(doc.activeElement);
      if (nodes.length) nodes[(index + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length].focus();
    } else if (event.key === 'Enter' && !event.defaultPrevented) {
      event.preventDefault(); event.stopPropagation(); controller.activate(controller.getState().revision);
    }
    event.stopPropagation();
  });
  for (const event of ['click', 'mousedown', 'mouseup', 'mousemove', 'keyup', 'textinput'])
    overlay.addEventListener(event, value => value.stopPropagation());
  listing.addEventListener('wheel', event => {
    event.preventDefault(); event.stopPropagation();
    const content = listing.childNodes[0];
    const height = content?.offsetHeight || 0;
    listing.scrollTop = Math.max(0, Math.min(Math.max(0, height - listing.offsetHeight), listing.scrollTop + event.deltaY));
  });
  paint(); focus('cancel');
  if (optInTheme) {
    try {
      themeBinding = subscribeDesktopTheme(snapshot => { theme = snapshot.ready ? snapshot.theme : null; paint(); },
        { native, onError: error => { themeError = String(error); reportError(themeError); paint(); } });
    } catch (error) { themeError = String(error); reportError(themeError); paint(); }
  }
  controller.start();
  return { result, controller, element: overlay, id: prefix,
    dispose: () => controller.dispose() };
}
