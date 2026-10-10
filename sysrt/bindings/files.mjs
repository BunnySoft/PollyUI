const common = {
  library: 'libc.so.6',
  target: { architecture: 'x86_64', pointerSize: 8, longSize: 8 },
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
    seek: { symbol: 'lseek', result: 'i64', parameters: ['i32', 'i64', 'i32'] },
    readAt: { symbol: 'pread', result: 'ssize', parameters: ['i32', 'pointer', 'size', 'i64'] },
    writeAt: { symbol: 'pwrite', result: 'ssize', parameters: ['i32', 'pointer', 'size', 'i64'] },
    truncate: { symbol: 'ftruncate', result: 'i32', parameters: ['i32', 'i64'] },
    symlink: { symbol: 'symlinkat', result: 'i32', parameters: ['cstring', 'i32', 'cstring'] },
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

export const fileSystemConstants = Object.freeze({
  AT_FDCWD: fileConstants.currentDirectory, AT_EMPTY_PATH: fileConstants.emptyPath,
  AT_SYMLINK_NOFOLLOW: fileConstants.noFollowStatus, AT_EACCESS: fileConstants.effectiveAccess,
  AT_REMOVEDIR: 0x200, STATX_BASIC_STATS: fileConstants.basicStatus,
  O_RDONLY: fileConstants.readOnly, O_RDWR: fileConstants.readWrite, O_WRONLY: fileConstants.writeOnly,
  O_CREAT: fileConstants.create, O_EXCL: fileConstants.exclusive, O_TRUNC: 0x200,
  O_APPEND: 0x400, O_NONBLOCK: fileConstants.nonblock, O_DIRECTORY: fileConstants.directory,
  O_NOFOLLOW: fileConstants.noFollow, O_CLOEXEC: fileConstants.closeOnExec, O_PATH: fileConstants.pathOnly,
  RENAME_NOREPLACE: fileConstants.noReplace, SEEK_SET: 0, SEEK_CUR: 1, SEEK_END: 2,
});
