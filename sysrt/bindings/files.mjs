const common = {
  library: 'libc.so.6',
  target: { pointerSize: 8, longSize: 8 },
  functions: {
    uid: { symbol: 'getuid', result: 'u32', parameters: [] },
    euid: { symbol: 'geteuid', result: 'u32', parameters: [] },
    gid: { symbol: 'getgid', result: 'u32', parameters: [] },
    egid: { symbol: 'getegid', result: 'u32', parameters: [] },
    environment: { symbol: 'getenv', result: 'pointer', parameters: ['cstring'] },
    stringLength: { symbol: 'strnlen', result: 'size', parameters: ['pointer', 'size'] },
    copy: { symbol: 'memcpy', result: 'pointer', parameters: ['pointer', 'pointer', 'size'] },
    open: { symbol: 'openat', result: 'i32', parameters: ['i32', 'cstring', 'i32', 'u32'], variadic: 3 },
    close: { symbol: 'close', result: 'i32', parameters: ['i32'] },
    status: { symbol: 'statx', result: 'i32', parameters: ['i32', 'cstring', 'i32', 'u32', 'pointer'] },
    entries: { symbol: 'getdents64', result: 'ssize', parameters: ['i32', 'pointer', 'size'] },
    access: { symbol: 'faccessat', result: 'i32', parameters: ['i32', 'cstring', 'i32', 'i32'] },
    linkTarget: { symbol: 'readlinkat', result: 'ssize', parameters: ['i32', 'cstring', 'pointer', 'size'] },
    read: { symbol: 'read', result: 'ssize', parameters: ['i32', 'pointer', 'size'] },
    write: { symbol: 'write', result: 'ssize', parameters: ['i32', 'pointer', 'size'] },
    mkdir: { symbol: 'mkdirat', result: 'i32', parameters: ['i32', 'cstring', 'u32'] },
    rename: { symbol: 'renameat2', result: 'i32', parameters: ['i32', 'cstring', 'i32', 'cstring', 'u32'] },
    link: { symbol: 'linkat', result: 'i32', parameters: ['i32', 'cstring', 'i32', 'cstring', 'i32'] },
    unlink: { symbol: 'unlinkat', result: 'i32', parameters: ['i32', 'cstring', 'i32'] },
    random: { symbol: 'getrandom', result: 'ssize', parameters: ['pointer', 'size', 'u32'] },
    sync: { symbol: 'fsync', result: 'i32', parameters: ['i32'] },
    mode: { symbol: 'fchmod', result: 'i32', parameters: ['i32', 'u32'] },
  },
  layouts: {
    statx: {
      byteLength: 256,
      fields: {
        mask: { type: 'u32', offset: 0 }, links: { type: 'u32', offset: 16 },
        uid: { type: 'u32', offset: 20 }, gid: { type: 'u32', offset: 24 },
        mode: { type: 'u16', offset: 28 }, inode: { type: 'u64', offset: 32 },
        size: { type: 'u64', offset: 40 },
        ctimeSeconds: { type: 'i64', offset: 96 }, ctimeNanos: { type: 'u32', offset: 104 },
        mtimeSeconds: { type: 'i64', offset: 112 }, mtimeNanos: { type: 'u32', offset: 120 },
        deviceMajor: { type: 'u32', offset: 136 }, deviceMinor: { type: 'u32', offset: 140 },
      },
    },
  },
};

export const filesBindings = {
  glibc: common,
  musl: { ...common, library: 'libc.musl-x86_64.so.1', functions: {
    ...common.functions,
    entries: { symbol: 'getdents', result: 'i32', parameters: ['i32', 'pointer', 'size'] },
  } },
};

export const fileConstants = Object.freeze({
  currentDirectory: -100, emptyPath: 0x1000, noFollowStatus: 0x100, effectiveAccess: 0x200,
  basicStatus: 0x7ff, readOnly: 0, readWrite: 2, writeOnly: 1, create: 0x40, exclusive: 0x80,
  nonblock: 0x800, directory: 0x10000, noFollow: 0x20000, closeOnExec: 0x80000, pathOnly: 0x200000,
  noReplace: 1, typeMask: 0xf000, regular: 0x8000, directoryType: 0x4000, symbolicLink: 0xa000,
});

export const fileDigestBindings = {
  library: 'libcrypto.so.3',
  target: { pointerSize: 8, longSize: 8 },
  functions: {
    algorithm: { symbol: 'EVP_sha256', result: 'pointer', parameters: [] },
    digest: { symbol: 'EVP_Digest', result: 'i32',
      parameters: ['pointer', 'size', 'pointer', 'pointer', 'pointer', 'pointer'] },
  },
};
