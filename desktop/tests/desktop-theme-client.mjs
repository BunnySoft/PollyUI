import { subscribeDesktopTheme } from './desktop/client/theme.mjs';
import { getDesktopTheme } from './desktop/shell/themes.mjs';

function check(value, message) { if (!value) throw new Error('FAIL: ' + message); console.log('PASS: ' + message); }
let starts = 0, stops = 0, previousCalls = 0;
const documentFor = id => JSON.stringify({ schemaVersion: 1, theme: getDesktopTheme(id) });
let snapshot = { available: false, ready: true, revision: 1, document: documentFor('xp'), error: '' };
const previous = () => previousCalls++;
const native = {
  startThemeSubscription() { starts++; snapshot.available = true; },
  stopThemeSubscription() { stops++; snapshot.available = false; },
  desktopThemeState() { return { ...snapshot }; },
  onDesktopThemeChanged: previous,
};
const circular = {}; circular.self = circular;
let rejected = false;
try { subscribeDesktopTheme(() => {}, { native, overrides: circular }); } catch { rejected = true; }
check(rejected && !starts, 'unserializable overrides do not acquire a subscription');
const updates = [], errors = [];
const first = subscribeDesktopTheme(state => updates.push(state), { native, onError: value => errors.push(String(value)),
  overrides: { colors: { accent: '#ff00aa' } } });
const second = subscribeDesktopTheme(() => {}, { native });
check(starts === 1 && updates[0].theme.colors.accent === '#ff00aa', 'opt-in bindings share one subscription and retain app overrides');
snapshot.revision++;
snapshot.document = documentFor('bigsur');
native.onDesktopThemeChanged();
check(updates.at(-1).theme.id === 'bigsur' && updates.at(-1).theme.colors.accent === '#ff00aa',
  'desktop changes do not overwrite application-specific colors');
check(previousCalls === 1, 'subscription chains the previous native callback');
const last = first.getState();
snapshot.revision++; snapshot.document = '{"not":"a theme"}';
native.onDesktopThemeChanged();
check(first.getState().theme === last.theme && first.getState().error && errors.length === 1,
  'bad provider data keeps the last valid application theme and reports an error');
snapshot.revision++; snapshot.document = documentFor('aqua');
native.onDesktopThemeChanged();
check(first.getState().theme.id === 'aqua' && !first.getState().error, 'valid data recovers after a bad snapshot');
first.setOverrides({ colors: { accent: '#123456' } });
check(first.getState().theme.colors.accent === '#123456', 'application overrides can be updated locally');
const stable = first.getState();
rejected = false;
try { first.setOverrides({ window: { titleHeight: 99999 } }); } catch { rejected = true; }
check(rejected && first.getState() === stable, 'invalid local override preserves the accepted snapshot');
first.stop();
check(stops === 0, 'removing one binding keeps remaining subscribers alive');
second.stop();
check(stops === 1 && native.onDesktopThemeChanged === previous, 'last binding restores callback ownership and stops its service');
first.stop(); second.stop();
check(stops === 1, 'binding cleanup is idempotent');
snapshot.available = true;
const external = subscribeDesktopTheme(() => {}, { native });
external.stop();
check(stops === 1, 'binding does not stop a subscription owned by its caller');
console.log('PASS: opt-in desktop themes, local overrides and subscription lifecycle');
