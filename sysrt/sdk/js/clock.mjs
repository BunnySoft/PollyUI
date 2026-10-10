import { platform } from 'sysrt:ffi';
import { loadBindings } from './sysrt/sdk/js/native.mjs';
import { clockBindings } from './sysrt/bindings/clock.mjs';

let bindings, frequency;

function failure(operation, result) {
  const error = new Error('OS monotonic clock failed: ' + operation);
  error.code = 'ERR_CLOCK_OS';
  error.nativeCode = result.errno ?? result.systemError;
  return error;
}

function ensure() {
  if (bindings) return;
  const description = clockBindings[platform];
  if (!description) throw new Error('Monotonic clock SDK is unavailable on ' + platform);
  const native = loadBindings(description.native);
  try {
    if (description.kind === 'qpc') {
      const record = native.createRecord('ticks');
      try {
        const result = native.call('frequency', record.pointer);
        if (result.value === 0) throw failure('frequency', result);
        frequency = record.read().value;
        if (frequency <= 0n) throw new Error('OS returned an invalid clock frequency');
      } finally { record.close(); }
    }
    bindings = native;
  } catch (error) { native.close(); throw error; }
}

export function monotonicNanoseconds() {
  ensure();
  const description = clockBindings[platform];
  const record = bindings.createRecord(description.kind === 'qpc' ? 'ticks' : 'timespec');
  try {
    if (description.kind === 'qpc') {
      const result = bindings.call('counter', record.pointer);
      if (result.value === 0) throw failure('counter', result);
      const counter = record.read().value;
      if (counter < 0n) throw new Error('OS returned an invalid clock counter');
      return counter * 1000000000n / frequency;
    }
    const result = bindings.call('read', description.clockId, record.pointer);
    if (result.value !== 0) throw failure('clock_gettime', result);
    const { seconds, nanoseconds } = record.read();
    if (seconds < 0n || nanoseconds < 0n || nanoseconds >= 1000000000n)
      throw new Error('OS returned an invalid timespec');
    return seconds * 1000000000n + nanoseconds;
  } finally { record.close(); }
}

export function close() {
  bindings?.close();
  bindings = frequency = undefined;
}
