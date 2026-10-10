import { monotonicNanoseconds, close } from './sysrt/sdk/js/clock.mjs';
import { platform } from 'sysrt:ffi';

if (platform === 'windows' || platform === 'linux') {
  const first = monotonicNanoseconds();
  const second = monotonicNanoseconds();
  if (typeof first !== 'bigint' || first < 0n || second < first)
    throw new Error('OS monotonic clock returned invalid data');
  close();
  if (monotonicNanoseconds() < second) throw new Error('Clock reload changed the monotonic source');
  close();
  console.log('PASS: OS monotonic clock through JS/config by-reference layouts');
} else {
  let rejected = false;
  try { monotonicNanoseconds(); } catch (error) {
    if (!String(error).includes('unavailable')) throw error;
    rejected = true;
  }
  if (!rejected) throw new Error('Unsupported clock profile must not use a fabricated fallback');
  console.log('PASS: unsupported clock profile is explicitly reported');
}
