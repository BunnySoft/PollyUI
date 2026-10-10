import { fileAbiTarget, fileAbiLayouts, nativeFileConstants as C } from './sysrt/bindings/generated/files-linux-x86_64.mjs';

const common = {
  library: 'libc.so.6',
  target: fileAbiTarget,
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
    lock: { symbol: 'flock', result: 'i32', parameters: ['i32', 'i32'] },
  },
  layouts: fileAbiLayouts,
};

export const filesBindings = {
  glibc: common,
  musl: { ...common, library: 'libc.musl-x86_64.so.1', functions: {
    ...common.functions,
    entries: { symbol: 'getdents', result: 'i32', parameters: ['i32', 'pointer', 'size'] },
  } },
};

export const fileConstants = Object.freeze({
  currentDirectory: C.AT_FDCWD, emptyPath: C.AT_EMPTY_PATH, noFollowStatus: C.AT_SYMLINK_NOFOLLOW, effectiveAccess: C.AT_EACCESS,
  basicStatus: C.STATX_BASIC_STATS, readOnly: C.O_RDONLY, readWrite: C.O_RDWR, writeOnly: C.O_WRONLY, create: C.O_CREAT, exclusive: C.O_EXCL,
  nonblock: C.O_NONBLOCK, directory: C.O_DIRECTORY, noFollow: C.O_NOFOLLOW, closeOnExec: C.O_CLOEXEC, pathOnly: C.O_PATH,
  noReplace: C.RENAME_NOREPLACE, typeMask: C.S_IFMT, regular: C.S_IFREG, directoryType: C.S_IFDIR, symbolicLink: C.S_IFLNK,
  exclusiveLock: C.LOCK_EX, nonblockingLock: C.LOCK_NB,
});

export const fileSystemConstants = Object.freeze({
  AT_FDCWD: fileConstants.currentDirectory, AT_EMPTY_PATH: fileConstants.emptyPath,
  AT_SYMLINK_NOFOLLOW: fileConstants.noFollowStatus, AT_EACCESS: fileConstants.effectiveAccess,
  AT_REMOVEDIR: C.AT_REMOVEDIR, STATX_BASIC_STATS: fileConstants.basicStatus,
  O_RDONLY: fileConstants.readOnly, O_RDWR: fileConstants.readWrite, O_WRONLY: fileConstants.writeOnly,
  O_CREAT: fileConstants.create, O_EXCL: fileConstants.exclusive, O_TRUNC: C.O_TRUNC,
  O_APPEND: C.O_APPEND, O_NONBLOCK: fileConstants.nonblock, O_DIRECTORY: fileConstants.directory,
  O_NOFOLLOW: fileConstants.noFollow, O_CLOEXEC: fileConstants.closeOnExec, O_PATH: fileConstants.pathOnly,
  RENAME_NOREPLACE: fileConstants.noReplace, SEEK_SET: C.SEEK_SET, SEEK_CUR: C.SEEK_CUR, SEEK_END: C.SEEK_END,
  LOCK_EX: C.LOCK_EX, LOCK_NB: C.LOCK_NB,
});
