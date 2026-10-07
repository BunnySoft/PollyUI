import { parseBundleManifest, validateBundleManifest, validateBundleRecord, planBundleLaunch, bundleDataPaths,
  bundleRelativePath } from './desktop/shared/app-bundle.mjs';
import { bundleCatalog } from './desktop/shell/bundles.mjs';
const check = (value, message) => {
  if (!value) throw new Error('FAIL: ' + message);
  console.log('PASS: ' + message);
};
function rejects(action, message) {
  let failed = false;
  try { action(); } catch { failed = true; }
  check(failed, message);
}
const source = {
  schemaVersion: 1, id: 'org.example.notes', name: 'Notes', version: '1.0.0',
  target: { os: 'linux', architecture: 'x86_64', libc: 'glibc' },
  launch: { kind: 'pollyui', entry: 'main.mjs', arguments: ['two words', '; not a shell command'] },
  data: { layout: 'pollyui', schema: 1 }, icon: 'resources/icon.png',
};
const environment = { HOME: '/home/polly' };
const options = { platform: source.target, environment, bundleRoot: '/apps/Notes 1.app', pollyuiExecutable: '/usr/bin/pollyui' };
const manifest = parseBundleManifest(JSON.stringify(source));
check(Object.isFrozen(manifest) && Object.isFrozen(manifest.launch.arguments), 'validated manifests are immutable snapshots');
const first = planBundleLaunch(manifest, options);
check(first.argv.join('|') === '/usr/bin/pollyui|--app-id|org.example.notes|/apps/Notes 1.app/main.mjs|two words|; not a shell command',
  'bundle launch uses explicit stable identity and literal argv without shell expansion');
check(Object.keys(first.environmentOverrides).length === 0 &&
  first.paths.dataDir === '/home/polly/.local/share/pollyui/org.example.notes',
  'PollyUI bundles reuse existing app namespaces without a second nesting layer');
const second = planBundleLaunch({ ...source, name: 'Renamed', version: '2.0.0' },
  { ...options, bundleRoot: '/new-disk/Notes 2.app' });
check(JSON.stringify(first.paths) === JSON.stringify(second.paths), 'version, display name and bundle location do not change appdata identity');
check(first.argv[3] !== second.argv[3] && first.cwd !== second.cwd, 'each launch is pinned to its concrete program version');
const other = planBundleLaunch({ ...source, id: 'org.example.different' }, options);
check(other.paths.dataDir !== first.paths.dataDir, 'different application IDs have separate namespaces');
const user = planBundleLaunch(source, { ...options, environment: { HOME: '/home/another' } });
check(user.paths.dataDir !== first.paths.dataDir, 'different user homes produce separate data locations');
const native = { ...source, launch: { kind: 'native', entry: 'bin/notes' }, data: { layout: 'xdg', schema: 1 } };
const plan = planBundleLaunch(native, options);
check(plan.argv[0] === '/apps/Notes 1.app/bin/notes' && !('HOME' in plan.environmentOverrides) &&
  plan.environmentOverrides.XDG_DATA_HOME === plan.paths.dataDir,
  'native adapter maps XDG roots without changing HOME or pretending to sandbox');
for (const path of ['/outside', '../outside', 'bin/../outside', './app', 'bin//app', 'bin/app/', 'C:\\app', 'https://host/app', 'bin/\0app'])
  rejects(() => bundleRelativePath(path), 'unsafe or ambiguous bundle path rejected');
for (const patch of [
  { schemaVersion: 2 }, { id: 'Notes' }, { id: 'org.Example.notes' }, { id: '../org.example.notes' },
  { version: 'latest' }, { version: '01.0.0' }, { name: ' ' }, { extra: true },
  { target: { ...source.target, os: 'windows' } }, { target: { ...source.target, libc: 'unknown' } },
  { launch: { ...source.launch, arguments: Array(65).fill('x') } },
  { launch: { ...source.launch, entry: 'bin/notes' } },
  { data: { layout: 'pollyui', schema: 0 } }, { data: { layout: 'xdg', schema: 1 } }, { icon: 'https://host/icon.png' },
])
  rejects(() => validateBundleManifest({ ...source, ...patch }), 'invalid manifest rejected before launch planning');
rejects(() => validateBundleManifest({ ...source, launch: { ...source.launch, arguments: ['\ud800'] } }), 'invalid Unicode rejected');
rejects(() => parseBundleManifest(' '.repeat(65537)), 'manifest source length is bounded');
rejects(() => parseBundleManifest('{"name":"' + '\u4e00'.repeat(23000) + '"}'), 'manifest source is bounded in bytes, not just characters');
rejects(() => validateBundleManifest({ ...source, launch: { ...source.launch, arguments: Array(1) } }), 'sparse argument arrays are rejected');
rejects(() => validateBundleManifest({ ...source, launch: { ...source.launch, arguments: Array(64).fill('x'.repeat(4096)) } }),
  'combined manifest byte limit is enforced');
rejects(() => planBundleLaunch(source, { ...options, platform: { ...source.target, libc: 'musl' } }), 'musl and glibc binaries are not interchangeable');
rejects(() => planBundleLaunch(source, { ...options, bundleRoot: '/home/polly' }), 'appdata cannot be placed under its program directory');
rejects(() => planBundleLaunch(source, { ...options, bundleRoot: first.paths.dataDir + '/versions/1.app' }),
  'program packages cannot be placed inside the application data directory');
rejects(() => planBundleLaunch(source, { ...options, pollyuiExecutable: 'pollyui' }), 'runtime is supplied as an absolute path, not a PATH search');
rejects(() => bundleDataPaths(source.id, { HOME: '/home/polly', XDG_DATA_HOME: 'relative' }), 'relative XDG bases are explicit errors');
const custom = bundleDataPaths(source.id, { HOME: '/home/polly', XDG_DATA_HOME: '/data', XDG_CACHE_HOME: '/scratch' });
check(custom.dataDir === '/data/pollyui/org.example.notes' && custom.cacheDir === '/scratch/pollyui/org.example.notes',
  'separate data and disposable cache volumes preserve the application ID');
rejects(() => bundleDataPaths(source.id, { HOME: '/home/polly', XDG_DATA_HOME: '/shared', XDG_CACHE_HOME: '/shared' }),
  'cache and durable data cannot resolve to the same directory');
rejects(() => bundleDataPaths(source.id, { HOME: '/home/polly', XDG_DATA_HOME: '/shared',
  XDG_CACHE_HOME: '/shared/pollyui/org.example.notes/nested' }), 'cache cannot be nested inside durable data');
check(planBundleLaunch({ ...source, data: { layout: 'pollyui', schema: 2 } }, options).paths.dataDir === first.paths.dataDir,
  'data-schema changes do not silently create a new empty data namespace');
const descriptor = {digest:'a'.repeat(64),manifest:source};
const record = validateBundleRecord({schemaVersion:1,current:descriptor,previous:null});
check(Object.isFrozen(record.current.manifest), 'installed records reuse the canonical immutable schema');
rejects(() => validateBundleRecord({...record, previous:{...descriptor,manifest:{...source,id:'org.example.wrong'}}}),
  'previous version cannot change the application identity');
rejects(() => validateBundleRecord({...record, previous:{...descriptor,manifest:{...source,data:{layout:'pollyui',schema:2}}}}),
  'incompatible data schemas cannot be registered for implicit rollback');
rejects(() => validateBundleRecord({...record,current:{...descriptor,digest:'../outside'}}),
  'content object reference is a fixed digest, never an arbitrary path');
const logs = [];
const catalog = bundleCatalog([{id:source.id,store:'/apps',contents:JSON.stringify(record)}],
  '/usr/bin/polly-app', () => true, message => logs.push(message));
check(catalog[0].id === 'bundle:org.example.notes' &&
  catalog[0].argv.join('|') === '/usr/bin/polly-app|run|org.example.notes|'+'a'.repeat(64),
  'Shell launch includes the observed digest, preventing stale catalog execution');
check(bundleCatalog([{id:source.id,store:'/apps',contents:'broken'}],'/usr/bin/polly-app',()=>true,
  message=>logs.push(message)).length === 0 && logs.length === 1, 'corrupt catalog records are logged and not launched');
