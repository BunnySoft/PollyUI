export const processBindings = Object.freeze({
  windows: {
    library: 'kernel32.dll',
    functions: { currentId: { symbol: 'GetCurrentProcessId', result: 'u32', parameters: [] } },
  },
  linux: {
    library: { glibc: 'libc.so.6', musl: 'libc.so' },
    functions: { currentId: { symbol: 'getpid', result: 'i32', parameters: [] } },
  },
  macos: {
    library: '/usr/lib/libSystem.B.dylib',
    functions: { currentId: { symbol: 'getpid', result: 'i32', parameters: [] } },
  },
});
