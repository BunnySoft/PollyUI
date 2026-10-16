import { h } from './gui/sdk/js/reconciler.mjs';
import { NInput } from './gui/sdk/js/naive.mjs';
import { getDesktopTheme, DEFAULT_DESKTOP_THEME } from './desktop/shell/themes.mjs';
import { desktopCommand, desktopIcon, desktopText, horizontal, scrollDesktop } from './desktop/shell/presentation.mjs';
import { parentPath } from './desktop/apps/files/logic/model.mjs';
import { formatSize, formatModified, fileType, visibleEntries } from './desktop/apps/files/ui/format.mjs';
import { inputAppearance } from './desktop/shared/ui/input-appearance.mjs';

function inInput(node) {
  for (let current = node; current; current = current.parentNode)
    if (current.getAttribute?.('role') === 'textbox' || ['files-name', 'files-address', 'files-filter'].includes(current.id)) return true;
  return false;
}

export function filesView(state, controller, { theme = null, themeError = '', width = 1040, height = 760, inputFor = null } = {}) {
  theme ||= getDesktopTheme(DEFAULT_DESKTOP_THEME);
  const color = key => theme.colors[key];
  const generation = state.generation, selection = state.selection;
  const ready = state.phase === 'ready', modal = !!(state.dialog || state.openWith);
  const inlineRename = state.dialog?.kind === 'rename';
  const usable = ready && !modal, entries = visibleEntries(state);
  const guarded = action => (...args) => controller.getState().generation === generation ? action(...args) : false;
  const label = (id, text, key = 'text', extra = {}) => h('view', { id, style: {
    color: color(key), fontFamily: 'sans-serif', fontSize: 14, flexShrink: 0, ...extra,
  } }, text);
  const command = (id, text, action, enabled = true, icon = '', style = {}, selected = false) =>
    desktopCommand(id, text, theme, guarded(action), { enabled, icon, style, selected, quiet: true });
  function input(id, value, placeholder, onInput, style = {}) {
    const appearance = inputAppearance(theme, 14);
    if (inputFor) {
      const enabled = id === 'files-filter' ? usable : id === 'files-address' ?
        !['working', 'opening'].includes(state.phase) : ready;
      const root = inputFor(id, value, placeholder, guarded(onInput), enabled, theme);
      return h('view', { id: id + '-slot', style: { width: '100%', height: appearance.fontSize + 18, flexShrink: 0, minWidth: 0,
        position: 'relative', ...style }, onMount: node => node.insertBefore(root, node.firstChild) },
        value ? null : desktopText(placeholder, color('muted'), appearance.fontSize, { position: 'absolute',
          left: 10, top: 9, pointerEvents: 'none' }));
    }
    const node = NInput({ id, value, placeholder, width: '100%', fontSize: appearance.fontSize, onInput: guarded(onInput),
      selectionColor: appearance.selectionColor, selectionTextColor: appearance.selectionTextColor });
    Object.assign(node.props, { role: 'textbox', 'aria-label': placeholder, 'aria-disabled': String(!ready),
      style: { ...node.props.style, ...style, backgroundColor: appearance.background,
        borderColor: appearance.borderColor, borderRadius: appearance.borderRadius },
      focusStyle: { borderColor: appearance.focusColor } });
    for (const child of node.children)
      if (child.props?.style?.color) child.props.style.color = value ? color('text') : color('muted');
    return node;
  }
  const crumbs = [{ name: '/', path: '/' }];
  let current = '';
  for (const part of state.path.split('/').filter(Boolean)) {
    current += '/' + part; crumbs.push({ name: part, path: current });
  }
  const address = state.address !== null
    ? input('files-address', state.address, 'Absolute folder path',
      value => controller.editAddress(value, generation), { flexGrow: 1, flexBasis: 0, minWidth: 0 })
    : h('view', { id: 'files-breadcrumbs', role: 'navigation', 'aria-label': 'Folder path',
      style: { ...horizontal, height: 36, flexGrow: 1, flexBasis: 0, minWidth: 80, gap: 2,
        overflow: 'scroll', backgroundColor: color('surface'), borderRadius: 6, borderWidth: 1, borderColor: color('border') },
      onWheel: event => scrollDesktop(event, true),
      onDblclick: guarded(() => controller.editAddress(null, generation)),
    }, crumbs.map((crumb, index) => command('files-crumb-' + index, crumb.name,
      () => controller.navigate(crumb.path), !modal, '', { paddingLeft: 8, paddingRight: 8, height: 32 },
      crumb.path === state.path)));
  const filter = input('files-filter', state.filter, 'Filter this folder',
    value => controller.filter(Array.from(value).slice(0, 128).join(''), generation),
    { flexGrow: 1, flexBasis: 0, minWidth: 0 });
  filter.props.tabIndex = inputFor ? -1 : usable ? 0 : -1;
  filter.props['aria-disabled'] = String(!usable);
  const header = h('view', { id: 'files-navigation', style: { padding: 12, gap: 10, flexShrink: 0,
    borderBottomWidth: 1, borderColor: color('border') } },
    h('view', { style: { ...horizontal, gap: 6, flexShrink: 0 } },
      command('files-back', 'Back', () => controller.back(generation), !modal && state.canBack, 'back', { width: 66, paddingLeft: 8, paddingRight: 6 }),
      command('files-forward', 'Forward', () => controller.forward(generation), !modal && state.canForward, 'forward', { width: 82, paddingLeft: 8, paddingRight: 6 }),
      command('files-parent', 'Up', () => controller.parent(generation), !modal && !!state.path && parentPath(state.path) !== state.path, 'up',
        { width: 58, paddingLeft: 6, paddingRight: 6 }),
      command('files-refresh', 'Refresh', () => controller.refresh(generation), !modal && !!state.path, 'refresh',
        { width: 84, paddingLeft: 6, paddingRight: 6 }),
      address,
      command('files-edit-address', 'Path', () => controller.editAddress(null, generation), !modal, '', { paddingLeft: 8, paddingRight: 8 })),
    h('view', { style: { ...horizontal, gap: 10, flexWrap: 'wrap', flexShrink: 0 } },
      h('view', { style: { ...horizontal, gap: 2, flexGrow: 1, flexShrink: 0, flexWrap: 'wrap' } },
        command('files-new-folder', 'New folder', () => controller.beginCreate(generation), usable, 'add'),
        command('files-open', 'Open', () => controller.open(generation, selection?.identity), usable && !!selection, 'open'),
        command('files-open-with', 'Open with', () => controller.showOpenWith(generation, selection?.identity),
          usable && selection?.type === 'file'),
        command('files-rename', 'Rename', () => controller.beginRename(generation, selection?.identity), usable && !!selection, 'rename'),
        command('files-cut', 'Cut', () => controller.cut(generation, selection?.identity),
          usable && state.moveAvailable && selection?.type === 'file'),
        command('files-paste', 'Paste...', () => controller.beginPaste(generation),
          usable && state.moveAvailable && !!state.cut),
        state.cut ? command('files-clear-cut', 'Cancel cut', () => controller.clearCut(generation), usable) : null,
        command('files-properties', 'Properties', () => controller.showProperties(generation, selection?.identity), usable && !!selection, 'info')),
      h('view', { style: { ...horizontal, gap: 8, width: 210, minWidth: 150, flexShrink: 1 } },
        desktopIcon('search', color('muted'), 18), filter,
        state.filter ? command('files-filter-clear', 'Clear', () => controller.filter('', generation), usable, '',
          { paddingLeft: 6, paddingRight: 6 }) : null)));

  const alerts = h('view', { id: 'files-notices', style: { gap: 6, paddingLeft: 16, paddingRight: 16, flexShrink: 0 } },
    state.snapshot && !state.snapshot.complete ? label('files-partial',
      'Partial folder: only the first 1024 entries are loaded. Filtering and sorting cover this snapshot, not the entire directory.', 'text',
      { padding: 10, backgroundColor: color('selection'), fontSize: 13, flexShrink: 1 }) : null,
    [['files-error', state.error], ['files-applications-error', state.applicationError], ['files-theme-error', themeError]]
      .filter(([, message]) => message).map(([id, message]) =>
      h('view', { id, role: 'alert',
        style: { borderLeftWidth: 3, borderColor: '#b42318', padding: 10, backgroundColor: color('surface'), flexShrink: 0 } },
      desktopText(message, color('text'), 14, { flexShrink: 1 }))));
  const columnStyle = (key, header = false) => ({
    width: key === 'name' ? '44%' : key === 'modified' ? '23%' : key === 'type' ? '21%' : '12%',
    flexShrink: 0, minWidth: 0, height: header ? 38 : 40, paddingLeft: key === 'name' ? 12 : 8,
    paddingRight: 8, justifyContent: 'center', overflow: 'hidden',
  });
  const columns = h('view', { id: 'files-columns', role: 'row', style: { ...horizontal,
    backgroundColor: color('body'), borderBottomWidth: 1, borderColor: color('border'), flexShrink: 0 } },
    [['name', 'Name'], ['modified', 'Modified'], ['type', 'Type'], ['size', 'Size']].map(([key, title]) => {
      const sort = state.sort.key === key ? state.sort.direction === 1 ? 'ascending' : 'descending' : 'none';
      const node = command('files-sort-' + key, title + (sort === 'none' ? '' : sort === 'ascending' ? ' ^' : ' v'),
        () => controller.sortBy(key, generation), usable, '', { ...columnStyle(key, true),
          justifyContent: 'flex-start', borderRadius: 0 });
      node.props.role = 'columnheader'; node.props['aria-sort'] = sort; return node;
    }));
  function context(entry, event) {
    event?.preventDefault?.(); event?.stopPropagation?.();
    if (!usable || controller.getState().generation !== generation) return false;
    const frame = event?.currentTarget?.ownerDocument?.body.getBoundingClientRect();
    const rect = event?.currentTarget?.getBoundingClientRect();
    const x = (event?.clientX ?? rect?.x ?? 220) - (frame?.x ?? 0);
    const y = (event?.clientY ?? rect?.y ?? 120) - (frame?.y ?? 0);
    return controller.showContext(entry.path, entry.identity, Math.max(8, Math.min(width - 232, x)),
      Math.max(8, Math.min(height - 260, y)), generation);
  }
  const rows = entries.map((entry, index) => {
    const chosen = selection?.path === entry.path && selection?.identity === entry.identity;
    const managed = state.applications.find(app => app.id.startsWith('bundle:') && app.path === entry.path);
    const node = h('view', { id: 'files-entry-' + index, role: 'option',
      'data-path': entry.path, 'data-identity': entry.identity, 'aria-label': entry.name,
      'aria-selected': String(chosen), tabIndex: usable && (chosen || (!selection && index === 0)) ? 0 : -1,
      style: { ...horizontal, height: 42, flexShrink: 0, borderWidth: 1, borderRadius: 4,
        borderColor: chosen ? color('accent') : 'transparent',
        backgroundColor: chosen ? color('selection') : color('surface') },
      hoverStyle: { backgroundColor: color('selection') }, focusStyle: { borderColor: color('focus') },
      onClick: event => {
        if (event?.button !== undefined && event.button !== 0) return false;
        event?.stopPropagation?.();
        return usable && controller.select(entry.path, entry.identity, generation);
      },
      onDblclick: () => {
        if (!usable || !controller.select(entry.path, entry.identity, generation)) return false;
        return controller.open(controller.getState().generation, entry.identity);
      },
      onContextmenu: event => context(entry, event),
      onKeydown: event => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) context(entry, event);
        else if (usable && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          if (controller.select(entry.path, entry.identity, generation) && event.key === 'Enter')
            return controller.open(controller.getState().generation, entry.identity);
        }
      },
    },
    h('view', { style: { ...columnStyle('name'), ...horizontal, gap: 10, justifyContent: 'flex-start',
      ...(inlineRename && chosen ? {} : { pointerEvents: 'none' }) } },
      desktopIcon(entry.type === 'directory' ? 'folder' : 'file', entry.type === 'directory' ? '#b07816' : color('accent'), 20),
      inlineRename && chosen ? input('files-name', state.dialog.name, 'Single folder or file name',
        value => controller.editName(value, generation), { flexGrow: 1, flexBasis: 0, minWidth: 0 }) :
        desktopText(entry.name, color('text'), 14, { flexShrink: 1, minWidth: 0, height: 20, overflow: 'hidden', pointerEvents: 'none' })),
    label(null, formatModified(entry.mtimeMs), 'muted', { ...columnStyle('modified'), fontSize: 13, pointerEvents: 'none' }),
    label(null, managed ? 'Application' : fileType(entry), 'muted', { ...columnStyle('type'), fontSize: 13, pointerEvents: 'none' }),
    label(null, entry.type === 'directory' ? '-' : formatSize(entry.bytes), 'muted',
      { ...columnStyle('size'), fontSize: 13, pointerEvents: 'none' }));
    return node;
  });
  if (!entries.length) rows.push(h('view', { id: ready ? state.filter ? 'files-no-matches' : 'files-empty' : 'files-list-state',
    style: { padding: 32, gap: 12, alignItems: 'center', flexShrink: 0 } },
    desktopIcon('folder', color('muted'), 40),
    desktopText(ready ? state.filter ? 'No matching names in this snapshot' : 'This folder is empty' :
      state.phase === 'loading' ? 'Reading folder...' : state.phase === 'error' ? 'Could not read this folder' : 'Waiting for Files...',
    color('text'), 18),
    desktopText(ready ? state.filter ? 'Change the folder filter to see more items.' : 'Use New folder to get started.' :
      'Choose a location or refresh to try again.', color('muted'), 13)));
  const list = h('view', { id: 'files-list', role: 'listbox', 'aria-label': 'Files and folders',
    'aria-multiselectable': 'false', tabIndex: usable ? 0 : -1,
    style: { flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0, overflow: 'scroll', padding: 4,
      backgroundColor: color('surface') }, onWheel: scrollDesktop,
  }, rows);
  const sidebar = h('view', { id: 'files-sidebar', role: 'navigation', 'aria-label': 'Places',
    style: { width: width < 760 ? 142 : 184, minWidth: 120, flexShrink: 0, padding: 8, gap: 4,
      backgroundColor: color('body'), borderRightWidth: 1, borderColor: color('border'), overflow: 'scroll' },
    onWheel: scrollDesktop },
    desktopText('Places', color('muted'), 12, { padding: 12, fontWeight: 600 }),
    Object.entries(state.locations ?? {}).map(([key, path]) => command('files-place-' + key,
      key[0].toUpperCase() + key.slice(1), () => controller.navigate(path), !modal, key,
      { height: 42, paddingLeft: 10 }, path === state.path)));
  const details = state.properties && selection ? h('view', { id: 'files-details', role: 'region', 'aria-label': 'Properties',
    style: { padding: 16, gap: 12, width: width < 900 ? 200 : 260, flexShrink: 0,
      borderLeftWidth: 1, borderColor: color('border'), overflow: 'scroll' }, onWheel: scrollDesktop },
    h('view', { style: { ...horizontal, flexWrap: 'wrap', gap: 6, flexShrink: 0 } },
      desktopText('Properties', color('text'), 18, { fontWeight: 600 }),
      command('files-details-close', 'Close', () => controller.cancel(generation), true, '',
        { paddingLeft: 6, paddingRight: 6 })),
    label('files-property-name', selection.name, 'text'),
    label('files-property-path', selection.path, 'muted', { fontSize: 12 }),
    label(null, fileType(selection) + ' | ' + formatSize(selection.bytes)),
    label(null, 'Modified: ' + (Number.isFinite(new Date(selection.mtimeMs).getTime()) ?
      new Date(selection.mtimeMs).toISOString() : String(selection.mtimeMs) + ' ms (outside date range)'),
      'muted', { fontSize: 12 }),
    label(null, 'Permissions: ' + selection.permissions + ' | UID ' + selection.uid + ' | GID ' + selection.gid, 'muted', { fontSize: 12 }),
    label(null, (selection.readable ? 'Readable' : 'Not readable') + ' | ' + (selection.writable ? 'Writable' : 'Not writable'), 'muted', { fontSize: 12 }),
    selection.type === 'symlink' ? label('files-property-link', 'Link target: ' + selection.linkTarget + ' (' +
      selection.targetType + ')' + (selection.targetError ? ' | ' + selection.targetError : ''), 'muted', { fontSize: 12 }) : null,
    ) : null;
  const listRegion = h('view', { id: 'files-list-region', style: { position: 'relative', flexGrow: 1,
    flexBasis: 0, minWidth: 0, minHeight: 0 } }, list,
    h('view', { id: 'files-scrollbar', role: 'scrollbar', 'aria-label': 'Scroll files and folders',
      'aria-controls': 'files-list', 'aria-orientation': 'vertical', tabIndex: -1,
      style: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 10,
        backgroundColor: color('body'), opacity: 0, pointerEvents: 'none', borderRadius: 5 },
      focusStyle: { backgroundColor: color('selection') } },
      h('view', { id: 'files-scroll-thumb', style: { position: 'absolute', left: 2, top: 0, width: 4,
        height: 28, borderRadius: 2, backgroundColor: color('muted'), pointerEvents: 'none' } })));
  const viewport = h('view', { id: 'files-viewport', style: { flexDirection: 'row', flexGrow: 1, flexBasis: 0,
    flexShrink: 1, minHeight: 100, overflow: 'hidden' } }, sidebar,
    h('view', { style: { flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0 } }, columns, listRegion), details);
  const footer = h('view', { id: 'files-status', role: 'status', style: { ...horizontal, flexShrink: 0,
    padding: 10, paddingLeft: 16, gap: 12, borderTopWidth: 1, borderColor: color('border'), flexWrap: 'wrap' } },
    desktopText(state.phase === 'working' ? 'Applying operation...' : state.phase === 'opening' ? 'Opening...' :
      state.phase === 'loading' ? 'Reading folder...' : state.snapshot ?
        entries.length + ' / ' + state.snapshot.entries.length + ' items' + (selection ? ' | 1 selected' : '') : 'Folder unavailable',
    color('muted'), 12),
    h('view', { style: { flexGrow: 1 } }),
    label('files-operation-limits', 'Moves: one regular file, same filesystem | No copy, delete or trash', 'muted',
      { fontSize: 12, flexShrink: 1 }),
    desktopText(state.message || (state.cut ? 'Cut: ' + state.cut.entry.name + ' | Paste reviews a move; no overwrite.' :
      'Folders first | Filter: loaded names only'), color('muted'), 12));

  let dialog = null;
  if (state.dialog || state.openWith) {
    const operation = state.dialog;
    const editing = operation && operation.kind !== 'link';
    dialog = h('view', { id: 'files-confirmation', role: 'dialog', 'aria-modal': String(!inlineRename),
      ...(inlineRename ? { style: { padding: 10, paddingLeft: 20, gap: 8, flexShrink: 0,
        backgroundColor: color('selection') } } : {
      style: { position: 'absolute', left: '10%', top: '18%', width: '80%', maxWidth: 620, padding: 22,
        gap: 14, borderRadius: 10, borderWidth: 1, borderColor: color('accent'), backgroundColor: color('surface') } }) },
      desktopText(state.openWith ? 'Open with' : operation.kind === 'link' ? 'Follow symbolic link?' :
        operation.kind === 'rename' ? 'Rename' : operation.kind === 'move' ? 'Move cut file here?' : 'New folder',
        color('text'), 22, { fontWeight: 600 }),
      editing && !inlineRename ? input('files-name', operation.name, 'Single folder or file name',
        value => controller.editName(value, generation)) : null,
      operation?.entry ? label('files-operation-source', operation.entry.path, 'muted', { fontSize: 13, flexShrink: 1 }) : null,
      operation?.kind === 'link' ? label('files-link-target', 'Target: ' + operation.entry.linkTarget +
        ' (' + operation.entry.targetType + '). Opening follows this link with your normal permissions.', 'text', { flexShrink: 1 }) : null,
      operation?.kind === 'rename' ? label('files-rename-note', 'Only this selected name changes. Existing destinations are never overwritten.', 'muted', { fontSize: 13, flexShrink: 1 }) : null,
      operation?.kind === 'move' ? label('files-move-note', 'Destination: ' + state.path +
        '\nMoves this regular file only, on the same filesystem. Existing names are never overwritten. Cancel leaves the source untouched.',
        'muted', { fontSize: 13, flexShrink: 1 }) : null,
      state.openWith ? [
        label('files-handler-title', state.openWith.entry.name + ' | ' + state.openWith.mimeType, 'muted', { flexShrink: 1 }),
        ...state.openWith.applications.map((app, index) => command('files-handler-' + index, app.name,
          () => controller.openWith(app.id, generation, selection?.identity), ready, 'apps')),
        command('files-handler-cancel', 'Cancel', () => controller.cancel(generation)),
      ] : h('view', { style: { ...horizontal, gap: 8, justifyContent: 'flex-end' } },
        command('files-cancel', 'Cancel', () => controller.cancel(generation)),
        desktopCommand('files-confirm', operation.kind === 'link' ? 'Follow link' : operation.kind === 'rename' ? 'Rename' :
          operation.kind === 'move' ? 'Move file' : 'Create folder',
          theme, guarded(() => controller.confirm(generation)), { enabled: ready })),
    );
  }
  const contextMenu = state.context && !modal && usable ? h('view', { id: 'files-context', role: 'menu', 'aria-label': 'Selected item',
    style: { position: 'absolute', left: state.context.x, top: state.context.y, width: 224, padding: 6, gap: 2,
      borderRadius: 8, borderWidth: 1, borderColor: color('border'), backgroundColor: color('surface') } },
    [['open', 'Open', () => controller.open(generation, selection?.identity), true, 'open'],
      ['open-with', 'Open with', () => controller.showOpenWith(generation, selection?.identity), selection?.type === 'file', 'apps'],
      ['rename', 'Rename', () => controller.beginRename(generation, selection?.identity), true, 'rename'],
      ['cut', 'Cut', () => controller.cut(generation, selection?.identity), state.moveAvailable && selection?.type === 'file', ''],
      ['properties', 'Properties', () => controller.showProperties(generation, selection?.identity), true, 'info']]
      .map(([id, text, action, enabled, icon]) => {
        const node = command('files-context-' + id, text, action, enabled, icon);
        node.props.role = 'menuitem'; return node;
      })) : null;
  return h('view', { id: 'files-root', style: { width: '100%', height: '100%', flexDirection: 'column',
    minWidth: 0, minHeight: 0, color: color('text'), backgroundColor: color('body'), overflow: 'hidden', position: 'relative' },
    onMousedown: event => {
      if (!state.context) return;
      for (let node = event.target; node; node = node.parentNode) if (node.id === 'files-context') return;
      controller.cancel(generation);
    },
    onKeydown: event => {
      if (event.defaultPrevented) return;
      const editing = inInput(event.target);
      if ((event.ctrlKey && event.key.toLowerCase() === 'l') || (event.altKey && event.key.toLowerCase() === 'd')) {
        event.preventDefault(); controller.editAddress(null, generation);
      } else if (event.key === 'Escape') {
        event.preventDefault(); controller.cancel(generation);
      } else if (event.target?.id === 'files-name' && event.key === 'Enter') {
        event.preventDefault(); controller.confirm(generation);
      } else if (event.target?.id === 'files-address' && event.key === 'Enter') {
        event.preventDefault(); if (controller.getState().generation === generation) controller.navigate(state.address);
      } else if (editing) return;
      else if (state.context && ['ArrowDown', 'ArrowUp', 'Tab'].includes(event.key)) {
        event.preventDefault();
        const document = event.currentTarget?.ownerDocument;
        const items = ['open', ...(selection?.type === 'file' ? ['open-with'] : []), 'rename',
          ...(state.moveAvailable && selection?.type === 'file' ? ['cut'] : []), 'properties']
          .map(id => document?.getElementById('files-context-' + id)).filter(Boolean);
        const old = items.indexOf(document?.activeElement);
        items[(old + (event.key === 'ArrowUp' || event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
      } else if (modal) return;
      else if (usable && event.ctrlKey && event.key.toLowerCase() === 'x') {
        event.preventDefault(); controller.cut(generation, selection?.identity);
      } else if (usable && event.ctrlKey && event.key.toLowerCase() === 'v') {
        event.preventDefault(); controller.beginPaste(generation);
      }
      else if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); controller.back(generation); }
      else if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); controller.forward(generation); }
      else if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); controller.parent(generation); }
      else if (usable && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) &&
          (event.target?.id?.startsWith('files-entry-') || event.target?.id === 'files-list' || !event.target)) {
        event.preventDefault();
        const old = entries.findIndex(entry => entry.path === selection?.path && entry.identity === selection?.identity);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 :
          Math.max(0, Math.min(entries.length - 1, old < 0 ? 0 : old + (event.key === 'ArrowDown' ? 1 : -1)));
        const entry = entries[index];
        if (entry) controller.select(entry.path, entry.identity, generation);
      } else if (event.key === 'F5') { event.preventDefault(); controller.refresh(generation); }
      else if (event.key === 'F2') { event.preventDefault(); controller.beginRename(generation, selection?.identity); }
      else if (event.key === 'Enter' && selection && !event.target?.id?.startsWith('files-context-')) {
        event.preventDefault(); controller.open(generation, selection.identity);
      }
    },
  }, header, alerts, inlineRename ? dialog : null, viewport, footer,
    dialog && !inlineRename ? h('view', { style: { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%',
      backgroundColor: color('body'), opacity: 0.7 }, onMousedown: event => event.stopPropagation() }) : null,
    inlineRename ? null : dialog, contextMenu);
}
