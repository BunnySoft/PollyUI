import { parseDesktopEntry, expandExec, applicationCatalog, createApplicationLauncher } from './desktop/shell/applications.mjs';
import { applicationsView } from './desktop/shell/views.mjs';
import { getDesktopTheme } from './desktop/shell/themes.mjs';
import { render } from './gui/sdk/js/reconciler.mjs';

function check(value, message) {
  if (!value) throw new Error('FAIL: ' + message);
  console.log('PASS: ' + message);
}
function rejects(fn, message) {
  let thrown = false;
  try { fn(); } catch { thrown = true; }
  check(thrown, message);
}
check('e\u0301'.normalize() === '\u00e9' && 'e\u0301'.localeCompare('\u00e9') === 0,
  'Unicode application sorting uses correctly typed normalization callbacks');
const file = (extra = '', id = 'app.desktop') => ({
  id, path: '/apps with spaces/' + id,
  contents: '[Desktop Entry]\nType=Application\nName=Base\nExec=program %f\n' + extra,
});
const entry = { name: 'Name with %u and spaces', path: '/apps/app file.desktop', icon: 'an-icon' };
check(JSON.stringify(expandExec('program %c %k %i %% %U', entry)) === JSON.stringify([
  'program', entry.name, entry.path, '--icon', 'an-icon', '%',
]), 'field codes expand once, preserve arguments and remove absent files');
check(JSON.stringify(expandExec('"/path with spaces/program" "" "two words" "a\\$b"', entry)) ===
  JSON.stringify(['/path with spaces/program', '', 'two words', 'a$b']), 'Exec quoting is not shell evaluation');
check(JSON.stringify(expandExec('program %d %D %n %N %v %m', entry)) === '["program"]', 'deprecated fields are removed');
for (const command of ['program %z', 'program %', 'program %f %U', 'program prefix%F',
  'program prefix%i', 'program "%c"', 'program unquoted;command', 'program "unclosed',
  'program "quoted"suffix', 'program "$HOME"', 'KEY=value program', './program', '']) {
  rejects(() => expandExec(command, entry), 'invalid Exec is rejected: ' + command);
}
let parsed = parseDesktopEntry(file('Name[zh]=中文\nName[zh_CN]=简体\nComment=Text\\svalue\n'), { locale: 'zh_CN.UTF-8' });
check(parsed.name === '简体' && parsed.comment === 'Text value', 'locale fallback and desktop string escapes');
parsed = parseDesktopEntry(file('Name[sr_RS@latin]=Specific\nName[sr_RS]=Country\nName[sr@latin]=Modifier\n'), { locale: 'sr_RS.UTF-8@latin' });
check(parsed.name === 'Specific', 'country and modifier locale precedence');
check(parseDesktopEntry(file('Hidden=true\n')) === null, 'Hidden removes an entry');
check(parseDesktopEntry(file('NoDisplay=true\n')) === null, 'NoDisplay removes an entry');
check(parseDesktopEntry(file('OnlyShowIn=GNOME;\n')) === null, 'foreign desktop-only entries are hidden');
check(parseDesktopEntry(file('OnlyShowIn=Polly;\n')) !== null, 'Polly-only entries are shown');
check(parseDesktopEntry(file('NotShowIn=Polly;\n')) === null, 'NotShowIn is honored');
check(parseDesktopEntry(file('TryExec=missing\n'), { canExecute: () => false }) === null, 'TryExec filters unavailable applications');
check(parseDesktopEntry(file('Terminal=true\n')).terminal, 'terminal apps retain their launch requirement');
rejects(() => parseDesktopEntry(file('Hidden=maybe\n')), 'invalid booleans are rejected');
rejects(() => parseDesktopEntry(file('Name=Duplicate\n')), 'duplicate keys are rejected');
rejects(() => parseDesktopEntry(file('Path=relative\n')), 'ambiguous relative working directories are rejected');
rejects(() => parseDesktopEntry(file('Comment=trailing\\\n')), 'incomplete escapes are rejected');
const bus = file('', 'org.pollyui.Bus.desktop');
bus.contents = '[Desktop Entry]\nType=Application\nName=Bus only\nDBusActivatable=true\n';
check(parseDesktopEntry(bus).unavailable.includes('qualified private session bus'), 'unqualified D-Bus-only activation is explicit');
const errors = [];
const files = [file('Hidden=true\n'), file('', 'second.desktop'), file('', 'app.desktop'),
  file('Name=Bad duplicate\n', 'bad.desktop')];
const catalog = applicationCatalog(files, {}, error => errors.push(error));
check(catalog.length === 1 && catalog[0].id === 'second.desktop' && errors.length === 1,
  'higher-priority entries mask lower copies and invalid files are reported');
let launched;
const native = {
  applicationFiles: () => [file('Terminal=true\n')],
  canExecute: () => true, locale: 'C', terminal: '/usr/bin/foot',
  spawnApplication: (argv, cwd, id) => { launched = { argv, cwd, id }; return 42; },
};
const launcher = createApplicationLauncher(native);
check(launcher.launch('app.desktop') === 42 && launched.argv.join('|') === '/usr/bin/foot|-e|program',
  'terminal launch is an explicit argv prefix');
rejects(() => launcher.launch('missing.desktop'), 'stale application IDs cannot launch arbitrary paths');
let query = '', selected = '';
const entries = [
  { id: 'one.desktop', name: 'One', comment: 'Editor', keywords: [], unavailable: '' },
  { id: 'two.desktop', name: 'Two', comment: 'Terminal', keywords: ['console'], unavailable: '' },
  { id: 'bus.desktop', name: 'Bus only', comment: '', keywords: [], unavailable: 'D-Bus required' },
];
function update() {
  render(applicationsView(getDesktopTheme('xp'), entries, query, value => { query = value; update(); },
    id => { selected = id; }, () => {}, () => {}), document.body);
}
update();
host.render();
document.getElementById('shell-app-search').focus();
host.text('console');
host.render();
check(!document.getElementById('shell-app-one.desktop') &&
  document.getElementById('shell-app-two.desktop'), 'launcher search uses application keywords');
host.key('Enter');
check(selected === 'two.desktop', 'search Enter activates the selected application ID');
query = ''; update(); host.render();
const application = document.getElementById('shell-app-one.desktop');
host.click(application.offsetLeft + 10, application.offsetTop + 10);
check(selected === 'one.desktop', 'launcher application buttons use native pointer dispatch');
check(document.getElementById('shell-app-bus.desktop').getAttribute('aria-disabled') === 'true',
  'unsupported activation is visibly disabled');
render(null, document.body);
