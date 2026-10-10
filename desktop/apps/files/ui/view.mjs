import { h } from './gui/sdk/js/reconciler.mjs';
import { NButton, NInput, lightTheme } from './gui/sdk/js/naive.mjs';
import { parentPath } from './desktop/apps/files/logic/model.mjs';
import { formatSize } from './desktop/apps/files/ui/format.mjs';

export function filesView(state, controller, { theme = null, themeError = '' } = {}) {
  const color = key => /^#[0-9a-f]{6}$/i.test(theme?.colors?.[key]) ? theme.colors[key] :
    ({ body: lightTheme.body, surface: lightTheme.card, text: lightTheme.text, muted: lightTheme.textSecondary,
      border: lightTheme.border, accent: lightTheme.info, error: lightTheme.error }[key]);
  const generation = state.generation, selection = state.selection;
  const ready = state.phase === 'ready';
  const label = (id, text, key = 'text') => h('view', { id, style: {
    color: color(key), fontSize: 13, flexShrink: 0,
  } }, text);
  function button(id, text, action, enabled = true, pressed = false) {
    const activate = event => {
      if (!enabled || (event?.button !== undefined && event.button !== 0)) return;
      event?.stopPropagation?.(); return action();
    };
    const node = NButton({ id, size: 'small', disabled: !enabled, onClick: activate }, text);
    Object.assign(node.props, { role: 'button', tabIndex: enabled ? 0 : -1, 'aria-label': text,
      'aria-disabled': String(!enabled), 'aria-pressed': String(pressed),
      onKeydown: event => {
        if (enabled && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault(); return activate(event);
        }
      }, focusStyle: { borderColor: color('accent') } });
    Object.assign(node.props.style, { color: color('text'), backgroundColor: color('surface'),
      borderColor: pressed ? color('accent') : color('border'), flexShrink: 0 });
    return node;
  }
  const row = { flexDirection: 'row', flexWrap: 'wrap', gap: 6, flexShrink: 0 };
  const crumbs = [{ name: '/', path: '/' }];
  let current = '';
  for (const part of state.path.split('/').filter(Boolean)) {
    current += '/' + part; crumbs.push({ name: part, path: current });
  }
  const entries = state.snapshot?.entries.slice(state.page * 64, (state.page + 1) * 64) ?? [];
  const pages = Math.max(1, Math.ceil((state.snapshot?.entries.length ?? 0) / 64));
  const content = [
    h('view', { style: row },
      button('files-back', 'Back', () => controller.back(generation), state.canBack),
      button('files-forward', 'Forward', () => controller.forward(generation), state.canForward),
      button('files-parent', 'Up', () => controller.parent(generation), !!state.path && parentPath(state.path) !== state.path),
      button('files-refresh', 'Refresh', () => controller.refresh(generation), !!state.path),
      button('files-new-folder', 'New folder', () => controller.beginCreate(generation), ready),
      button('files-rename', 'Rename selected', () => controller.beginRename(generation, selection?.identity), ready && !!selection),
      button('files-open', 'Open selected', () => controller.open(generation, selection?.identity), ready && !!selection),
      button('files-open-with', 'Open With...', () => controller.showOpenWith(generation, selection?.identity),
        ready && selection?.type === 'file')),
    h('view', { id: 'files-breadcrumbs', role: 'navigation', 'aria-label': 'Folder path', style: row },
      crumbs.map((crumb, index) => button('files-crumb-' + index, crumb.name,
        () => controller.navigate(crumb.path), true, crumb.path === state.path))),
    label('files-path', state.path || 'No folder opened', 'muted'),
    label('files-status', state.phase === 'loading' ? 'Reading directory...' :
      state.phase === 'working' ? 'Applying file operation...' : state.phase === 'opening' ? 'Opening...' :
      state.phase === 'error' ? 'Folder or operation failed; refresh or choose another folder.' :
      state.snapshot ? state.snapshot.entries.length + ' entries' : 'Native file API not ready', 'muted'),
    state.snapshot && !state.snapshot.complete ? label('files-partial',
      'Partial list: first 1024 entries only. Use a smaller folder; this is not the complete directory.', 'error') : null,
    state.error ? label('files-error', state.error, 'error') : null,
    state.message ? label('files-message', state.message) : null,
    state.applicationError ? label('files-applications-error', state.applicationError, 'error') : null,
    themeError ? label('files-theme-error', themeError, 'error') : null,
  ];
  if (state.dialog) {
    const dialog = state.dialog;
    content.push(h('view', { id: 'files-confirmation', role: 'dialog', 'aria-modal': 'true',
      style: { padding: 12, gap: 8, borderWidth: 1, borderColor: color('accent'), flexShrink: 0 } },
      label('files-confirmation-title', dialog.kind === 'link' ? 'Follow symbolic link?' :
        dialog.kind === 'rename' ? 'Confirm rename of this exact entry' : 'Create a new folder'),
      dialog.entry ? label('files-operation-source', dialog.entry.path) : null,
      dialog.kind === 'link' ? label('files-link-target', 'Target: ' + dialog.entry.linkTarget +
        ' (' + dialog.entry.targetType + '). Opening follows this link using your normal permissions.') :
        NInput({ id: 'files-name', value: dialog.name, width: 360, placeholder: 'Single folder/file name',
          onInput: value => controller.editName(value, generation) }),
      dialog.kind === 'rename' ? label('files-rename-note', 'Only the selected name changes. Existing destinations are never overwritten.') : null,
      h('view', { style: row },
        button('files-confirm', dialog.kind === 'link' ? 'Follow link' : dialog.kind === 'rename' ? 'Confirm rename' : 'Create folder',
          () => controller.confirm(generation), ready),
        button('files-cancel', 'Cancel', () => controller.cancel(generation)))));
  }
  if (state.openWith) {
    content.push(h('view', { id: 'files-handler-picker', role: 'dialog', style: { gap: 6, flexShrink: 0 } },
      label('files-handler-title', 'Open With: ' + state.openWith.entry.name + ' (' + state.openWith.mimeType + ')'),
      state.openWith.applications.map((app, index) => button('files-handler-' + index, app.name,
        () => controller.openWith(app.id, generation, selection?.identity), ready)),
      button('files-handler-cancel', 'Cancel Open With', () => controller.cancel(generation))));
  }
  const rows = entries.map((entry, index) => {
    const date = new Date(entry.mtimeMs);
    const modified = Number.isFinite(date.getTime()) ? date.toISOString() : String(entry.mtimeMs) + ' ms (outside date range)';
    const managed = state.applications.find(app => app.id.startsWith('bundle:') && app.path === entry.path);
    const description = managed ? 'Managed application: ' + managed.name :
      entry.type === 'symlink' ? 'Link -> ' + entry.linkTarget + ' (' + entry.targetType +
        (entry.targetError ? ', ' + entry.targetError : '') + ')' : entry.type;
    const caption = entry.name + ' | ' + description;
    const node = button('files-entry-' + index, caption,
      () => controller.select(entry.path, entry.identity, generation), ready, selection?.path === entry.path);
    Object.assign(node.props, { role: 'option', 'aria-selected': String(selection?.path === entry.path),
      onDblclick: () => {
        if (!ready || !controller.select(entry.path, entry.identity, generation)) return false;
        return controller.open(controller.getState().generation, entry.identity);
      } });
    return h('view', { id: 'files-row-' + index, style: { gap: 3, flexShrink: 0, paddingBottom: 6 } },
      node, label('files-properties-' + index, formatSize(entry.bytes) + ' | modified ' +
        modified + ' | mode ' + entry.permissions + ' | UID ' + entry.uid +
        ' | ' + (entry.readable ? 'readable' : 'not readable') + ' | ' + (entry.writable ? 'writable' : 'not writable'), 'muted'));
  });
  if (ready && !entries.length) rows.push(label('files-empty', 'This folder is empty.', 'muted'));
  const list = h('view', { id: 'files-list', role: 'listbox', 'aria-label': 'Files and folders',
    style: { flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0, overflow: 'scroll', gap: 6 },
    onWheel: event => {
      event.preventDefault();
      const node = event.currentTarget;
      const extent = node.childNodes.reduce((end, child) =>
        Math.max(end, child.offsetTop + child.offsetHeight - node.offsetTop), 0);
      node.scrollTop = Math.max(0, Math.min(Math.max(0, extent - node.offsetHeight),
        Number(node.scrollTop) + event.deltaY));
    },
  }, rows);
  const sidebar = h('view', { id: 'files-sidebar', role: 'navigation', 'aria-label': 'Places',
    style: { width: 150, gap: 8, flexShrink: 0 } },
    Object.entries(state.locations ?? {}).map(([key, path]) => button('files-place-' + key,
      key[0].toUpperCase() + key.slice(1), () => controller.navigate(path), true, path === state.path)));
  content.push(h('view', { style: { flexDirection: 'row', gap: 12, flexGrow: 1, flexBasis: 0,
    flexShrink: 1, minHeight: 120, overflow: 'hidden' } }, sidebar, list),
    h('view', { style: row },
      button('files-page-previous', 'Previous page', () => controller.page(state.page - 1, generation), ready && state.page > 0),
      label('files-page-status', 'Page ' + (state.page + 1) + ' / ' + pages, 'muted'),
      button('files-page-next', 'Next page', () => controller.page(state.page + 1, generation), ready && state.page < pages - 1)));
  return h('view', { id: 'files-root', style: {
    width: '100%', height: '100%', padding: 12, gap: 8, flexDirection: 'column',
    color: color('text'), backgroundColor: color('body'), overflow: 'hidden',
  }, onKeydown: event => {
    const editing = event.target?.id === 'files-name';
    if (event.key === 'Escape') { event.preventDefault(); controller.cancel(generation); }
    else if (editing && event.key === 'Enter') { event.preventDefault(); controller.confirm(generation); }
    else if (!editing && event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); controller.back(generation); }
    else if (!editing && event.altKey && event.key === 'ArrowRight') { event.preventDefault(); controller.forward(generation); }
    else if (!editing && ready && !state.dialog && !state.openWith &&
        (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const all = state.snapshot.entries, old = all.findIndex(entry => entry.path === selection?.path);
      const index = Math.max(0, Math.min(all.length - 1, old < 0 ? 0 : old + (event.key === 'ArrowDown' ? 1 : -1)));
      const entry = all[index];
      if (entry && controller.select(entry.path, entry.identity, generation)) {
        controller.page(Math.floor(index / 64), controller.getState().generation);
      }
    }
    else if (!editing && event.key === 'F5') { event.preventDefault(); controller.refresh(generation); }
    else if (!editing && event.key === 'F2') { event.preventDefault(); controller.beginRename(generation, selection?.identity); }
    else if (!editing && event.key === 'Enter' && selection && !state.dialog && !state.openWith) {
      event.preventDefault(); controller.open(generation, selection.identity);
    }
  } }, content);
}
