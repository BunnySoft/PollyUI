import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../release/debian/00-polly-power.rules', import.meta.url), 'utf8');
let rule;
runInNewContext(source, { polkit: { Result: { YES: 'yes', NO: 'no' }, addRule(value) { rule = value; } } });
const local = { user: 'polly', active: true, local: true, seat: 'seat0', session: 'c1' };

test('only the two basic actions grant an actual active local polly seat subject', () => {
  for (const action of ['org.freedesktop.login1.power-off', 'org.freedesktop.login1.reboot']) {
    assert.equal(rule({ id: action }, local), 'yes');
    for (const change of [{ user: 'root' }, { user: 'another-user' }, { user: 'polly-greeter' },
      { active: false }, { local: false }, { active: 'true' }, { local: 'true' },
      { seat: '' }, { session: '' }, { seat: undefined }, { session: undefined }])
      assert.equal(rule({ id: action }, { ...local, ...change }), 'no');
  }
});

test('no multiple-session, inhibitor bypass, firmware, sleep or generic execution grant is added', () => {
  for (const action of ['power-off-multiple-sessions', 'power-off-ignore-inhibit',
    'reboot-multiple-sessions', 'reboot-ignore-inhibit', 'set-reboot-to-firmware-setup',
    'set-reboot-to-boot-loader-menu', 'set-reboot-to-boot-loader-entry', 'set-reboot-parameter', 'set-wall-message', 'halt',
    'kexec', 'soft-reboot', 'suspend', 'suspend-multiple-sessions', 'hibernate',
    'hybrid-sleep', 'suspend-then-hibernate'])
    assert.equal(rule({ id: 'org.freedesktop.login1.' + action }, local), 'no');
  for (const action of ['org.freedesktop.policykit.exec', 'org.freedesktop.hostname1.set-hostname',
    'org.freedesktop.login1.inhibit-delay-shutdown', 'org.freedesktop.login1.set-user-linger'])
    assert.equal(rule({ id: action }, local), undefined, 'unrelated policy stays with its existing standard owner');
  assert.equal(rule({ id: 'org.freedesktop.login1.suspend' }, { ...local, user: 'another-user' }), undefined);
});
