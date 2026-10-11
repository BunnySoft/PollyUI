import { runtimeBuild } from './desktop/client/settings-contract.mjs';

const expected = application.arguments[0];
if (!/^[0-9a-f]{40}$/.test(expected)) throw new Error('Expected explicit frozen runtime revision');
const ownBuild = runtimeBuild();
if (ownBuild.version !== '0.1.0-alpha.7' || ownBuild.revision !== expected || ownBuild.sourceDirty !== false)
  throw new Error('Actual installed runtime identity differs from frozen Alpha.7: ' + JSON.stringify(ownBuild));
console.log('POLLY_VM_SETTINGS_BUILD=' + JSON.stringify({
  probe: ownBuild,
  observation: 'Actual installed application metadata; production Settings About/footer observed in QMP screenshots, not cross-PID DBus access.',
}));
window.quit();
