import { DISPLAY_PROFILE_KEY, displayProfile, readDisplayProfile, displayRestorePlan,
  createDisplayPersistence } from './desktop/shell/display-profiles.mjs';
function check(value, message) { if (!value) throw new Error('FAIL: ' + message); console.log('PASS: ' + message); }
function rejects(action, message) { let failed = false; try { action(); } catch { failed = true; } check(failed, message); }
const head = { id: 5, name: 'DP-1', make: 'Polly fixture', model: 'Monitor', serialNumber: 'A123',
  enabled: true, width: 1280, height: 720, refresh: 60000, scale: 1, transform: 0, x: 0, y: 0, adaptiveSync: false };
const snapshot = { serial: 72, pendingToken: 0, heads: [head] };
const profile = displayProfile(snapshot);
check(!('id' in profile.heads[0]) && !('serial' in profile), 'profile excludes live display IDs and transaction serials');
check(!displayRestorePlan(profile, snapshot).draft, 'unchanged geometry does not apply or ask for confirmation');
const changed = { ...snapshot, serial: 999, heads: [{ ...head, id: 81, scale: 1.25 }] };
const plan = displayRestorePlan(profile, changed);
check(plan.draft.serial === 999 && plan.draft.heads[0].id === 81 && plan.draft.heads[0].scale === 1,
  'restore binds saved settings to fresh live IDs and serial');
check(!displayRestorePlan(profile, { ...snapshot, heads: [{ ...head, serialNumber: 'replacement' }] }).draft,
  'different physical identity never matches solely by connector name');
check(!displayRestorePlan(profile, { ...snapshot, heads: [{ ...head, name: 'DP-2' }] }).draft,
  'connector changes preserve safe layout');
check(!displayRestorePlan(profile, { ...snapshot, heads: [{ ...head, serialNumber: '' }] }).draft,
  'missing hardware identity prevents automatic restore');
check(!displayRestorePlan(profile, { ...snapshot, heads: [head, { ...head, id: 8, name: 'DP-2' }] }).draft,
  'duplicated monitor serial identity is ambiguous even on different connectors');
const two = displayProfile({ ...snapshot, heads: [head, { ...head, id: 8, name: 'DP-2', serialNumber: 'B456' }] });
check(!displayRestorePlan(two, snapshot).draft, 'missing monitor preserves safe layout');
check(!displayRestorePlan(two, { ...snapshot, heads: [
  { ...head, id: 8, name: 'DP-2', serialNumber: 'B456' }, head] }).draft, 'enumeration order does not change identity matching');
const disabled = { ...head, name: 'DP-2', serialNumber: 'B456', enabled: false, width: 0, height: 0 };
check(!displayRestorePlan(displayProfile({ ...snapshot, heads: [head, disabled] }),
  { ...snapshot, heads: [head, { ...disabled, width: 800, height: 600 }] }).draft,
  'unused geometry on disabled displays does not trigger confirmation');
rejects(() => displayProfile({ ...snapshot, pendingToken: 1 }), 'unconfirmed snapshot cannot be saved');
for (const patch of [{ scale: 0 }, { scale: 5 }, { width: 1.5 }, { width: 0 }, { transform: 8 },
  { enabled: false }, { enabled: 1 }, { adaptiveSync: 'yes' }, { x: 32769 }, { serialNumber: '\0' }]) {
  rejects(() => readDisplayProfile(JSON.stringify({ version: 1, heads: [{ ...profile.heads[0], ...patch }] })),
    'invalid profile data is rejected before application');
}
rejects(() => readDisplayProfile(JSON.stringify({ ...profile, extra: 1 })), 'unknown profile fields are rejected');
rejects(() => readDisplayProfile(' '.repeat(65537)), 'profile file limit is enforced');
let saved = JSON.stringify(profile), calls = 0, claimed = false, failWrite = false;
const errors = [];
const storage = {
  getItem(key) { check(key === DISPLAY_PROFILE_KEY, 'dedicated display profile key'); return saved; },
  setItem(key, value) { if (failWrite) throw new Error('disk full'); saved = value; },
  removeItem() { saved = null; },
};
const native = {
  claimOutputStartup() { if (claimed) return false; claimed = true; return true; },
  outputConfiguration: () => changed,
  applyOutputConfiguration(draft) { calls++; check(draft.serial === 999, 'startup apply uses current serial'); return 1; },
};
let persistence = createDisplayPersistence({ native, storage, failure: error => errors.push(String(error)) });
persistence.start();
check(calls === 1 && saved === JSON.stringify(profile), 'startup restore is provisional and does not persist by itself');
persistence.observe({ pendingToken: 0, outcome: 2 });
check(persistence.status.includes('reverted'), 'profile status follows actual compositor rollback');
persistence = createDisplayPersistence({ native, storage, failure: error => errors.push(String(error)) });
persistence.start();
check(calls === 1, 'new Shell instance cannot automatically retry within the same compositor');
failWrite = true;
rejects(() => persistence.save(changed), 'failed storage write is surfaced after confirmation');
check(saved === JSON.stringify(profile), 'storage failure preserves previous durable profile');
failWrite = false;
persistence.save(changed);
check(JSON.parse(saved).heads[0].scale === 1.25, 'confirmed snapshot replaces saved geometry');
saved = '{broken'; claimed = false;
persistence.start();
check(calls === 1 && saved === '{broken' && errors.length, 'corrupt profile is reported and not overwritten');
persistence.forget();
check(saved === null && calls === 1, 'forgetting preferences does not mutate connected displays');
