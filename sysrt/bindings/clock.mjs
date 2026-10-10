export const clockBindings = Object.freeze({
  windows: {
    kind: 'qpc',
    native: {
      library: 'kernel32.dll',
      target: { pointerSize: 8, longSize: 4 },
      functions: {
        counter: { symbol: 'QueryPerformanceCounter', result: 'i32', parameters: ['pointer'] },
        frequency: { symbol: 'QueryPerformanceFrequency', result: 'i32', parameters: ['pointer'] },
      },
      layouts: { ticks: { byteLength: 8, fields: { value: { type: 'i64', offset: 0 } } } },
    },
  },
  linux: {
    kind: 'posix',
    clockId: 1,
    native: {
      library: { glibc: 'libc.so.6', musl: 'libc.so' },
      target: { pointerSize: 8, longSize: 8 },
      functions: {
        read: { symbol: 'clock_gettime', result: 'i32', parameters: ['i32', 'pointer'] },
      },
      layouts: {
        timespec: { byteLength: 16, fields: {
          seconds: { type: 'i64', offset: 0 }, nanoseconds: { type: 'long', offset: 8 },
        } },
      },
    },
  },
});
