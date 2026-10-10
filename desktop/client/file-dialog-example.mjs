import { h, render } from './gui/sdk/js/reconciler.mjs';
import { createTextInput } from './gui/sdk/js/textinput.mjs';
import { utf8Bytes } from './desktop/shell/documents.mjs';
import { requireFileSystem, fileEntry, fileError, parentPath, pathValue,
  textObservation } from './desktop/apps/files/logic/model.mjs';
import { showFileDialog } from './desktop/client/file-dialog.mjs';

export function parseFileTextArguments(values) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string'))
    throw new TypeError('File Text arguments must be strings');
  const options = { initialDirectory: null, initialFile: null, optInTheme: false };
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === '--theme') options.optInTheme = true;
    else if (value === '--file') {
      if (options.initialFile !== null || values[index + 1] === undefined)
        throw new Error('--file requires exactly one absolute local file path');
      options.initialFile = pathValue(values[++index]);
    } else {
      if (value.startsWith('--') || options.initialDirectory !== null)
        throw new Error('Use one initial directory, --file LOCALPATH, and optional --theme');
      options.initialDirectory = pathValue(value);
    }
  }
  return options;
}

export function createFileTextApp({ host = window, files,
  native = typeof desktop === 'undefined' ? null : desktop, optInTheme = false,
  initialDirectory = null, initialFile = null, suggestedName = 'note.txt',
  reportError = message => console.error('[file-text] ' + message) } = {}) {
  let surface = null, dialog = null, closed = false, generation = 0, busy = false;
  let status = 'Open reads a real file. Save writes your text only after a target is chosen.';
  let contents = '', lastPath = '', saved = null, controls = null, output = null, text = null;
  let unavailable = '';
  if (files === undefined) {
    try { files = requireFileSystem(native); }
    catch (error) { unavailable = fileError(error); reportError(unavailable); files = null; }
  }
  const live = token => !closed && !surface.closed && token === generation;
  function paint() {
    if (!surface || closed || surface.closed) return;
    const button = (id, caption, action) => h('view', { id, role: 'button', tabIndex: busy ? -1 : 0,
      'aria-disabled': String(busy), style: { padding: 10, borderWidth: 1, borderRadius: 3,
        borderColor: '#cbd5e1', backgroundColor: '#ffffff', opacity: busy ? 0.5 : 1 },
      focusStyle: { borderColor: '#2080f0' }, onClick: event => {
        if (!busy && event.button === 0) return action();
      }, onKeydown: event => {
        if (!busy && ['Enter', ' '].includes(event.key)) { event.preventDefault(); return action(); }
      } }, caption);
    render(h('view', { style: { gap: 10 } },
      h('view', { style: { fontSize: 20, color: '#333639' } }, 'Native file chooser - real text use'),
      h('view', { style: { flexDirection: 'row', gap: 8 } },
        button('file-text-open', 'Open and read', open),
        button('file-text-save', 'Choose target and write text', save)),
      h('view', { style: { color: '#666a73', fontSize: 13 } }, 'Text to write (one line, at most 4096 UTF-8 bytes):')), controls);
    render(h('view', { style: { gap: 9 } },
      h('view', { id: 'file-text-status', style: { color: '#333639', fontSize: 14 } }, unavailable || status),
      h('view', { id: 'file-text-path', style: { color: '#666a73', fontSize: 13 } }, lastPath),
      h('view', { id: 'file-text-content', style: { color: '#333639', fontSize: 14 } }, contents)), output);
  }
  function chooser(mode, notice = '') {
    dialog = showFileDialog({ parent: surface, files, native, optInTheme,
      settings: { mode, initialDirectory, suggestedName, defaultExtension: 'txt',
        filters: [{ label: 'Text files (.txt / .md)', extensions: ['txt', 'md'] },
          { label: 'All files', extensions: [] }] }, notice, reportError });
    return dialog.result;
  }
  function report(error, label, token) {
    reportError(fileError(error));
    if (!live(token)) return;
    status = label + ': ' + fileError(error);
    paint();
  }
  async function readChoice(choice, token) {
    status = 'Reading file...'; paint();
    const read = await files.readText(choice.path, choice.identity);
    if (!live(token)) return;
    if (!read || read.path !== choice.path || read.identity !== choice.identity || typeof read.text !== 'string')
      throw new Error('Native read returned mismatched file identity or text');
    contents = read.text.slice(0, 4096);
    lastPath = read.path; initialDirectory = parentPath(choice.selectedPath); suggestedName = read.path.split('/').at(-1);
    status = 'Read ' + utf8Bytes(read.text) + ' UTF-8 bytes from the selected file.' +
      (read.text.length > 4096 ? ' Display is limited to the first 4096 characters.' : '');
  }
  async function open() {
    if (busy || closed) return;
    busy = true; const token = ++generation; saved = null; paint();
    try {
      const choice = await chooser('open');
      dialog = null;
      if (!live(token)) return;
      if (choice.status === 'cancelled') { status = 'Open cancelled. No content was read.'; return; }
      await readChoice(choice, token);
    } catch (error) { report(error, 'Open failed', token); }
    finally { if (live(token)) { busy = false; paint(); } }
  }
  async function openPath(path) {
    if (busy || closed) return;
    if (!surface) throw new Error('Start File Text before opening a named file');
    busy = true; const token = ++generation; saved = null;
    status = 'Inspecting named file...'; paint();
    try {
      if (!files) throw new Error(unavailable || 'Native ordinary-user filesystem API is unavailable.');
      const observed = textObservation(await files.observeText(pathValue(path)));
      if (!live(token)) return;
      await readChoice({ path: observed.path, identity: observed.identity, selectedPath: observed.path }, token);
    } catch (error) { report(error, 'Open named file failed', token); }
    finally { if (live(token)) { busy = false; paint(); } }
  }
  async function save() {
    if (busy || closed) return;
    const value = text.value;
    if (value.includes('\0') || utf8Bytes(value) > 4096) {
      status = 'Text must contain no NUL and fit within 4096 UTF-8 bytes.';
      reportError(status); paint(); return;
    }
    busy = true; const token = ++generation; saved = null; paint();
    let choice = null, committed = false;
    try {
      choice = await chooser('save');
      while (live(token) && choice.status === 'selected') {
        dialog = null;
        status = 'Writing through the shared ordinary-user filesystem...'; paint();
        let written;
        try {
          written = choice.overwrite ?
            await files.replaceText(choice.path, value, choice.expectedIdentity, choice.parentIdentity) :
            await files.writeText(choice.parentPath, choice.name, value, choice.parentIdentity);
        } catch (error) {
          if (!live(token)) { reportError(fileError(error)); return; }
          if (choice.overwrite && error.code === 'ESTALE') {
            initialDirectory = choice.parentPath; suggestedName = choice.name;
            reportError(fileError(error));
            choice = await chooser('save', 'File changed before replacement. No replacement was published. Choose the target and confirm its fresh observation again.');
            continue;
          }
          throw error;
        }
        committed = true;
        if (!live(token)) return;
        const observation = fileEntry(written);
        if (observation.path !== choice.path || observation.type !== 'file')
          throw new Error('Native write returned an unexpected destination');
        const read = await files.readText(observation.path, observation.identity);
        if (!live(token)) return;
        if (read.path !== observation.path || read.identity !== observation.identity || read.text !== value)
          throw new Error('Written content did not match its native readback');
        saved = observation; lastPath = observation.path; contents = read.text;
        initialDirectory = choice.parentPath; suggestedName = choice.name;
        status = 'Saved and read back ' + utf8Bytes(value) + ' UTF-8 bytes: ' + observation.path;
        return;
      }
      if (live(token)) status = 'Save cancelled. No write was requested.';
    } catch (error) {
      report(error, committed ? 'Write completed but readback failed; inspect the file before retrying' : 'Save failed', token);
    } finally { dialog = null; if (live(token)) { busy = false; paint(); } }
  }
  function stop() {
    if (closed) return;
    closed = true; generation++;
    dialog?.dispose(); dialog = null;
    if (surface && !surface.closed) surface.close();
  }
  return {
    open, openPath, save, stop, getWindow: () => surface, getDialog: () => dialog,
    getState: () => ({ busy, status, contents, lastPath, saved, closed }),
    start() {
      if (closed) throw new Error('Closed file example cannot restart');
      if (surface) return this;
      surface = host.create({ title: 'PollyUI.FileText', width: 880, height: 700 });
      surface.onclose = stop;
      controls = surface.document.createElement('view'); output = surface.document.createElement('view');
      text = createTextInput({ document: surface.document, value: 'PollyUI saved text', width: '100%', fontSize: 14 });
      text.root.id = 'file-text-input'; text.root.setAttribute('aria-label', 'Text to write');
      const root = surface.document.createElement('view');
      root.id = 'file-text-root';
      Object.assign(root.style, { width: '100%', height: '100%', padding: '18', gap: '12',
        backgroundColor: '#f5f7fa', overflow: 'scroll' });
      root.appendChild(controls); root.appendChild(text.root); root.appendChild(output);
      root.addEventListener('wheel', event => {
        event.preventDefault();
        const height = root.childNodes.reduce((end, node) =>
          Math.max(end, node.offsetTop + node.offsetHeight - root.offsetTop), 0);
        root.scrollTop = Math.max(0, Math.min(Math.max(0, height - root.offsetHeight), root.scrollTop + event.deltaY));
      });
      surface.document.body.appendChild(root);
      host.close(); paint();
      if (initialFile !== null) openPath(initialFile);
      return this;
    },
  };
}
