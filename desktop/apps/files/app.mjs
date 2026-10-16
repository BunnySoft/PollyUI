import { render } from './gui/sdk/js/reconciler.mjs';
import { subscribeDesktopTheme } from './desktop/client/theme.mjs';
import { createApplicationLauncher } from './desktop/shell/applications.mjs';
import { requireFileSystem } from './desktop/apps/files/logic/model.mjs';
import { createFilesController } from './desktop/apps/files/logic/controller.mjs';
import { filesView } from './desktop/apps/files/ui/view.mjs';
import { visibleEntries } from './desktop/apps/files/ui/format.mjs';
import { createTextInput } from './gui/sdk/js/textinput.mjs';
import { createVerticalScrollbar } from './gui/sdk/js/scrollbar.mjs';
import { inputAppearance } from './desktop/shared/ui/input-appearance.mjs';
import { scrollbarAppearance } from './desktop/shared/ui/scrollbar-appearance.mjs';
import { getDesktopTheme, DEFAULT_DESKTOP_THEME } from './desktop/shared/ui/themes.mjs';

export function createFilesApp({ host = window, native = typeof desktop === 'undefined' ? null : desktop,
  initialPath = null, optInTheme = true, reportError = message => console.error('[files] ' + message) } = {}) {
  let surface = null, themeBinding = null, theme = null, themeError = '', stopped = false, api = null, apiError = null;
  let previous = null;
  let scrollbar = null, scrollTrack = null, syncTimer = null, layoutWidth = 0, layoutHeight = 0;
  const inputs = new Map();
  function retireInput(id) {
    const record = inputs.get(id);
    if (!record) return;
    record.input.root.parentNode?.removeChild(record.input.root);
    inputs.delete(id);
  }
  try { api = requireFileSystem(native); } catch (error) { apiError = error; reportError(String(error)); }
  const launcher = native && typeof native.applicationFiles === 'function' ? createApplicationLauncher(native, reportError) : null;
  function inputFor(id, value, placeholder, changed, enabled, theme) {
    let record = inputs.get(id);
    if (!record) {
      const input = createTextInput({ window: surface, value, width: '100%', fontSize: 14, padding: 9,
        ...(id === 'files-filter' ? { maxLength: 128 } : {}) });
      input.root.id = id; input.root.setAttribute('role', 'textbox');
      record = { input, changed, enabled };
      inputs.set(id, record);
      const edited = () => {
        if (inputs.get(id) !== record || stopped) return;
        if (record.enabled) record.changed(input.value);
      };
      input.root.addEventListener('textinput', edited);
      input.root.addEventListener('keydown', event => {
        if (['Backspace', 'Delete'].includes(event.key) ||
            ((event.ctrlKey || event.metaKey) && ['x', 'v'].includes(event.key.toLowerCase()))) edited();
      });
    }
    record.changed = changed; record.enabled = enabled;
    if (record.input.value !== value) record.input.value = value;
    record.input.root.tabIndex = enabled ? 0 : -1;
    record.input.root.setAttribute('aria-label', placeholder);
    record.input.root.setAttribute('aria-disabled', String(!enabled));
    record.input.root.style.pointerEvents = enabled ? 'auto' : 'none';
    record.input.setAppearance(inputAppearance(theme, 14));
    return record.input.root;
  }
  function paint() {
    if (stopped || !surface || surface.closed) return;
    const state = controller.getState(), document = surface.document, active = document.activeElement;
    if (previous && previous.generation !== state.generation) scrollbar?.cancel(true);
    if (!state.dialog || state.dialog.kind === 'link' || state.dialog.generation !== previous?.dialog?.generation)
      retireInput('files-name');
    if (state.address === null) retireInput('files-address');
    const rowFocused = active?.id?.startsWith('files-entry-') || active?.id === 'files-list';
    const selectedChanged = state.selection && (previous?.selection?.path !== state.selection.path ||
      previous?.selection?.identity !== state.selection.identity);
    const dialogOpened = state.dialog && state.dialog.generation !== previous?.dialog?.generation;
    const contextOpened = state.context && state.context !== previous?.context;
    const addressOpened = state.address !== null && previous?.address === null;
    const clearedFilter = previous?.filter && !state.filter;
    const dismissed = (previous?.dialog && !state.dialog) || (previous?.context && !state.context) ||
      (previous?.properties && !state.properties) || (previous && previous.address !== null && state.address === null);
    const folderReady = state.phase === 'ready' && state.snapshot !== previous?.snapshot;
    if (state.filter !== previous?.filter || state.snapshot !== previous?.snapshot) {
      const list = document.getElementById('files-list');
      if (list) list.scrollTop = 0;
    }
    render(filesView(state, controller, { theme, themeError,
      inputFor, width: document.body.offsetWidth || 1040, height: document.body.offsetHeight || 760 }), document.body);
    for (const [id, { input }] of inputs) {
      const slot = document.getElementById(id + '-slot');
      if (slot && input.root.parentNode !== slot) slot.insertBefore(input.root, slot.firstChild);
    }
    const track = document.getElementById('files-scrollbar');
    const scrollAppearance = scrollbarAppearance(theme || getDesktopTheme(DEFAULT_DESKTOP_THEME), 'overlay');
    if (track !== scrollTrack) {
      scrollbar?.stop(); scrollTrack = track;
      scrollbar = track ? createVerticalScrollbar({ viewport: document.getElementById('files-list'),
        track, thumb: document.getElementById('files-scroll-thumb'), appearance: scrollAppearance,
        isCurrent: () => !stopped && !surface?.closed && controller.getState().phase === 'ready' &&
          !controller.getState().dialog && !controller.getState().openWith }) : null;
    }
    scrollbar?.setAppearance(scrollAppearance);
    scrollbar?.update();
    previous = state;
    let id = dialogOpened && state.dialog.kind !== 'link' ? 'files-name' :
      contextOpened ? 'files-context-open' : addressOpened ? 'files-address' :
      (selectedChanged || rowFocused || dismissed) && state.selection ? 'files-entry-' +
        visibleEntries(state).findIndex(entry => entry.path === state.selection.path && entry.identity === state.selection.identity) :
        dismissed || clearedFilter || (folderReady && !['files-name', 'files-filter', 'files-address'].includes(active?.id)) ?
          'files-list' : null;
    if (id) {
      document.getElementById(id)?.focus();
      const expected = state.generation;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (stopped || controller.getState().generation !== expected || surface?.closed) return;
        const node = document.getElementById(id), list = document.getElementById('files-list');
        if (document.activeElement && document.activeElement !== node) return;
        node?.focus();
        if ((dialogOpened && id === 'files-name') || (addressOpened && id === 'files-address'))
          inputs.get(id)?.input.selectAll();
        if (!node || !list || !['files-name', 'files-entry-'].some(prefix => id.startsWith(prefix))) return;
        const rect = node.getBoundingClientRect(), viewport = list.getBoundingClientRect();
        if (rect.y < viewport.y) list.scrollTop = Math.max(0, Number(list.scrollTop) + rect.y - viewport.y - 4);
        else if (rect.y + rect.height > viewport.y + viewport.height)
          list.scrollTop = Math.max(0, Number(list.scrollTop) + rect.y + rect.height - viewport.y - viewport.height + 4);
        scrollbar?.update();
      }));
    }
  }
  const controller = createFilesController({ api: apiError ? { locations() { throw apiError; } } : api,
    launcher, onChange: paint, reportError });
  function stop() {
    if (stopped) return;
    stopped = true;
    if (syncTimer !== null) clearInterval(syncTimer);
    syncTimer = null; scrollbar?.stop(); scrollbar = null; scrollTrack = null;
    for (const { input } of inputs.values()) input.root.blur();
    inputs.clear();
    controller.dispose(); themeBinding?.stop(); themeBinding = null;
    const current = surface; surface = null;
    if (current && !current.closed) current.close();
  }
  return {
    controller, stop, getWindow: () => surface,
    start() {
      if (stopped) throw new Error('Closed Files app cannot restart; create a new instance');
      if (surface && !surface.closed) return this;
      surface = host.create({ title: 'Files', width: 1040, height: 760 });
      surface.onclose = stop;
      surface.document.body.tabIndex = 0;
      host.close(); paint(); surface.document.body.focus();
      syncTimer = setInterval(() => {
        if (stopped || !surface || surface.closed) return;
        const { offsetWidth: width, offsetHeight: height } = surface.document.body;
        if (width !== layoutWidth || height !== layoutHeight) {
          layoutWidth = width; layoutHeight = height; paint();
        }
        scrollbar?.update();
      }, 100);
      if (optInTheme && typeof native?.startThemeSubscription === 'function') {
        try {
          themeBinding = subscribeDesktopTheme(snapshot => {
            theme = snapshot.ready ? snapshot.theme : null; themeError = ''; paint();
          }, { native, onError: error => { themeError = String(error); reportError(themeError); paint(); } });
        } catch (error) { themeError = String(error); reportError(themeError); paint(); }
      }
      controller.start(initialPath);
      return this;
    },
  };
}
