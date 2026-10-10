export const processBindings = Object.freeze({
  windows: {
    library: 'kernel32.dll',
    target: { architecture: 'x86_64', pointerSize: 8, longSize: 4 },
    functions: {
      currentId: { symbol: 'GetCurrentProcessId', result: 'u32', parameters: [] },
      current: { symbol: 'GetCurrentProcess', result: 'pointer', parameters: [] },
      open: { symbol: 'OpenProcess', result: 'pointer', parameters: ['u32', 'i32', 'u32'] },
      close: { symbol: 'CloseHandle', result: 'i32', parameters: ['pointer'] },
      exitCode: { symbol: 'GetExitCodeProcess', result: 'i32', parameters: ['pointer', 'pointer'] },
      wait: { symbol: 'WaitForSingleObject', result: 'u32', parameters: ['pointer', 'u32'] },
      terminate: { symbol: 'TerminateProcess', result: 'i32', parameters: ['pointer', 'u32'] },
      create: { symbol: 'CreateProcessW', result: 'i32',
        parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'i32', 'u32', 'pointer', 'pointer', 'pointer', 'pointer'] },
    },
    layouts: {
      startupInfo: { byteLength: 104, fields: { size: { type: 'u32', offset: 0 } } },
      processInfo: { byteLength: 24, fields: {
        processId: { type: 'u32', offset: 16 }, threadId: { type: 'u32', offset: 20 },
      } },
    },
  },
  linux: {
    library: { glibc: 'libc.so.6', musl: 'libc.musl-x86_64.so.1' },
    target: { architecture: 'x86_64', pointerSize: 8, longSize: 8 },
    functions: {
      currentId: { symbol: 'getpid', result: 'i32', parameters: [] },
      parentId: { symbol: 'getppid', result: 'i32', parameters: [] },
      userId: { symbol: 'getuid', result: 'u32', parameters: [] },
      effectiveUserId: { symbol: 'geteuid', result: 'u32', parameters: [] },
      groupId: { symbol: 'getgid', result: 'u32', parameters: [] },
      effectiveGroupId: { symbol: 'getegid', result: 'u32', parameters: [] },
      group: { symbol: 'getpgid', result: 'i32', parameters: ['i32'] },
      session: { symbol: 'getsid', result: 'i32', parameters: ['i32'] },
      signal: { symbol: 'kill', result: 'i32', parameters: ['i32', 'i32'] },
      wait: { symbol: 'waitpid', result: 'i32', parameters: ['i32', 'pointer', 'i32'] },
      spawn: { symbol: 'posix_spawn', result: 'i32',
        parameters: ['pointer', 'cstring', 'pointer', 'pointer', 'pointer', 'pointer'] },
      spawnPath: { symbol: 'posix_spawnp', result: 'i32',
        parameters: ['pointer', 'cstring', 'pointer', 'pointer', 'pointer', 'pointer'] },
    },
  },
  macos: {
    library: '/usr/lib/libSystem.B.dylib',
    functions: { currentId: { symbol: 'getpid', result: 'i32', parameters: [] } },
  },
});

export const processConstants = Object.freeze({
  linux: Object.freeze({ WNOHANG: 1, WUNTRACED: 2, WCONTINUED: 8, SIGTERM: 15, SIGKILL: 9 }),
  windows: Object.freeze({ INFINITE: 0xffffffff, WAIT_OBJECT_0: 0, WAIT_TIMEOUT: 258,
    PROCESS_TERMINATE: 1, PROCESS_QUERY_LIMITED_INFORMATION: 0x1000, SYNCHRONIZE: 0x100000 }),
});
