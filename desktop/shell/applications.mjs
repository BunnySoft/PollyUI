import { bundleCatalog } from './desktop/shell/bundles.mjs';

function unescapeValue(value, list = false) {
  let result = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '\\') { result += value[i]; continue; }
    const code = value[++i];
    const escapes = { s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' };
    if (list && code === ';') { result += ';'; continue; }
    if (!(code in escapes)) throw new Error('Invalid desktop-entry escape: \\' + code);
    result += escapes[code];
  }
  return result;
}

function listValue(value = '') {
  const values = [];
  let part = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && i + 1 < value.length) part += value[i] + value[++i];
    else if (value[i] === ';') { if (part) values.push(unescapeValue(part, true)); part = ''; }
    else part += value[i];
  }
  if (part) values.push(unescapeValue(part, true));
  return values;
}

function localized(values, key, locale, decode = true) {
  const match = /^([A-Za-z]+)(?:_([A-Za-z0-9]+))?(?:\.[^@]*)?(?:@(.+))?$/.exec(locale || '');
  if (match) {
    const [, language, country, modifier] = match;
    const variants = [
      country && modifier && `${language}_${country}@${modifier}`,
      country && `${language}_${country}`, modifier && `${language}@${modifier}`, language,
    ];
    for (const variant of variants) {
      if (variant && values.has(`${key}[${variant}]`)) {
        const value = values.get(`${key}[${variant}]`);
        return decode ? unescapeValue(value) : value;
      }
    }
  }
  const value = values.get(key) || '';
  return decode ? unescapeValue(value) : value;
}

function boolean(values, key) {
  if (!values.has(key)) return false;
  if (values.get(key) === 'true') return true;
  if (values.get(key) === 'false') return false;
  throw new Error(key + ' must be true or false');
}

function tokenize(command) {
  const tokens = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i])) i++;
    if (i === command.length) break;
    let text = '';
    const quoted = command[i] === '"';
    if (quoted) {
      i++;
      let closed = false;
      while (i < command.length) {
        const character = command[i++];
        if (character === '"') { closed = true; break; }
        if (character === '\\') {
          if (i === command.length || !['"', '\\', '$', '`'].includes(command[i]))
            throw new Error('Invalid quoted Exec escape');
          text += command[i++];
        } else {
          if (character === '$' || character === '`') throw new Error('Unescaped reserved Exec character');
          text += character;
        }
      }
      if (!closed || (i < command.length && !/\s/.test(command[i])))
        throw new Error('Exec arguments must be quoted in whole');
    } else {
      while (i < command.length && !/\s/.test(command[i])) {
        const character = command[i++];
        if ('"\'\\><~|&;$*?#()`'.includes(character)) throw new Error('Unquoted reserved Exec character');
        text += character;
      }
    }
    tokens.push({ text, quoted });
  }
  return tokens;
}

export function expandExec(command, entry) {
  const result = [];
  let files = 0;
  for (const { text, quoted } of tokenize(command)) {
    if (text === '%i' && !quoted) {
      if (entry.icon) result.push('--icon', entry.icon);
      continue;
    }
    let value = '';
    let removed = false;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '%') { value += text[i]; continue; }
      const code = text[++i];
      if (!code) throw new Error('Trailing percent in Exec');
      if (code === '%') { value += '%'; continue; }
      if (quoted) throw new Error('Field codes inside quoted Exec arguments are undefined');
      if ('fFuU'.includes(code)) {
        if (++files > 1) throw new Error('Exec may contain only one file/URL field code');
        if ('FU'.includes(code) && text !== '%' + code) throw new Error('List field code must be a separate argument');
        removed = true;
      } else if ('dDnNvm'.includes(code)) removed = true;
      else if (code === 'c') value += entry.name;
      else if (code === 'k') value += entry.path;
      else if (code === 'i') throw new Error('%i must be a separate argument');
      else throw new Error('Unknown Exec field code: %' + code);
    }
    if (value || !removed) result.push(value);
  }
  if (!result.length || !result[0] || result[0].includes('='))
    throw new Error('Invalid Exec executable');
  if (result.some(value => value.includes('\0'))) throw new Error('Exec contains NUL');
  if (result[0].includes('/') && !result[0].startsWith('/')) throw new Error('Relative Exec paths are unsupported');
  return result;
}

export function applicationActivationTarget(id) {
  if (typeof id !== 'string' || !id.endsWith('.desktop'))
    throw new Error('D-Bus application ID must end in .desktop');
  const busName = id.slice(0, -8);
  const match = /^[A-Za-z_-][A-Za-z0-9_-]*(?:\.[A-Za-z_-][A-Za-z0-9_-]*)+$/.exec(busName);
  if (busName.length > 255 || !match || match[0] !== busName)
    throw new Error('Invalid D-Bus application desktop ID');
  return { busName, objectPath: '/' + busName.replaceAll('.', '/').replaceAll('-', '_') };
}

export function parseDesktopEntry(file, { locale = 'C', desktops = ['Polly'], canExecute = () => true,
  activationAvailable = false } = {}) {
  if (file.contents.includes('\0')) throw new Error('Desktop entry contains NUL');
  const values = new Map();
  let active = false, found = false;
  for (const raw of file.contents.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      if (!line.endsWith(']')) throw new Error('Invalid desktop-entry group');
      active = line === '[Desktop Entry]';
      if (active && found) throw new Error('Duplicate Desktop Entry group');
      if (active) found = true;
      continue;
    }
    if (!active) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('Invalid desktop-entry key');
    const key = line.slice(0, separator).trim();
    if (values.has(key)) throw new Error('Duplicate desktop-entry key: ' + key);
    values.set(key, line.slice(separator + 1).trim());
  }
  if (!found || values.get('Type') !== 'Application') return null;
  if (boolean(values, 'Hidden') || boolean(values, 'NoDisplay')) return null;
  const only = listValue(values.get('OnlyShowIn'));
  const not = listValue(values.get('NotShowIn'));
  if (only.some(name => not.includes(name))) throw new Error('Conflicting desktop visibility rules');
  let visible = !values.has('OnlyShowIn');
  for (const desktop of desktops) {
    if (only.includes(desktop)) { visible = true; break; }
    if (not.includes(desktop)) { visible = false; break; }
  }
  if (!visible) return null;
  const tryExec = values.has('TryExec') ? unescapeValue(values.get('TryExec')) : '';
  if (tryExec && !canExecute(tryExec)) return null;
  const dbusActivatable = boolean(values, 'DBusActivatable');
  const name = localized(values, 'Name', locale);
  if (!values.has('Name') || !name) throw new Error('Application entry requires Name');
  const entry = {
    id: file.id, path: file.path, name, comment: localized(values, 'Comment', locale),
    genericName: localized(values, 'GenericName', locale),
    icon: values.has('Icon') ? unescapeValue(values.get('Icon')) : '',
    cwd: values.has('Path') ? unescapeValue(values.get('Path')) : '',
    terminal: boolean(values, 'Terminal'), categories: listValue(values.get('Categories')),
    keywords: listValue(localized(values, 'Keywords', locale, false)), argv: null, activation: null, unavailable: '',
  };
  if (entry.cwd && !entry.cwd.startsWith('/')) throw new Error('Relative application working directories are unsupported');
  if (!values.get('Exec')) {
    if (!dbusActivatable) throw new Error('Application entry requires Exec');
    entry.activation = applicationActivationTarget(entry.id);
    if (!activationAvailable) entry.unavailable = 'D-Bus activation requires a qualified private session bus';
    return entry;
  }
  entry.argv = expandExec(unescapeValue(values.get('Exec')), entry);
  if (!canExecute(entry.argv[0])) entry.unavailable = 'Executable is unavailable';
  return entry;
}

export function applicationCatalog(files, options = {}, report = console.error) {
  const seen = new Set(), entries = [];
  for (const file of files) {
    if (seen.has(file.id)) continue;
    seen.add(file.id); // Hidden/invalid higher-priority files mask lower-priority entries.
    try {
      const entry = parseDesktopEntry(file, options);
      if (entry) entries.push(entry);
    } catch (error) {
      report('[applications] Skipping ' + file.path + ': ' + String(error));
    }

  }
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return entries;
}

export function createApplicationLauncher(native, report = console.error) {
  let entries = [];
  return {
    refresh() {
      entries = applicationCatalog(native.applicationFiles(), {
        locale: native.locale, desktops: ['Polly'], canExecute: name => native.canExecute(name),
        activationAvailable: typeof native.activateApplication === 'function' &&
          typeof native.canActivateApplication === 'function' && native.canActivateApplication(),
      }, report);
      if (typeof native.bundleFiles === 'function') {
        entries.push(...bundleCatalog(native.bundleFiles(), native.bundleManager, name => native.canExecute(name), report));
        entries.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      }
      for (const entry of entries) {
        if (!entry.activation && entry.terminal && !native.canExecute(native.terminal))
          entry.unavailable = 'Configured terminal is unavailable: ' + native.terminal;
      }
      return entries.map(entry => ({ ...entry, argv: entry.argv && [...entry.argv],
        activation: entry.activation && { ...entry.activation } }));
    },
    launch(id) {
      this.refresh();
      const entry = entries.find(item => item.id === id);
      if (!entry) throw new Error('Application is no longer available');
      if (entry.unavailable) throw new Error(entry.unavailable);
      if (entry.activation) return native.activateApplication(entry.id);
      const argv = entry.terminal ? [native.terminal, '-e', ...entry.argv] : entry.argv;
      return native.spawnApplication(argv, entry.cwd, entry.id);
    },
  };
}
