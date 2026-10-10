const addressLayouts = {
  sockaddrIn: { byteLength: 16, fields: {
    family: { type: 'u16', offset: 0 }, port: { type: 'u16', offset: 2 },
    address: { type: 'u32', offset: 4 },
  } },
  sockaddrIn6: { byteLength: 28, fields: {
    family: { type: 'u16', offset: 0 }, port: { type: 'u16', offset: 2 },
    flowInfo: { type: 'u32', offset: 4 }, address: { type: 'bytes', offset: 8, byteLength: 16 },
    scopeId: { type: 'u32', offset: 24 },
  } },
};
const byteOrder = {
  htons: { symbol: 'htons', result: 'u16', parameters: ['u16'] },
  ntohs: { symbol: 'ntohs', result: 'u16', parameters: ['u16'] },
  htonl: { symbol: 'htonl', result: 'u32', parameters: ['u32'] },
  ntohl: { symbol: 'ntohl', result: 'u32', parameters: ['u32'] },
};

export const networkBindings = {
  linux: {
    library: { glibc: 'libc.so.6', musl: 'libc.musl-x86_64.so.1' },
    target: { architecture: 'x86_64', pointerSize: 8, longSize: 8 },
    functions: {
      ...byteOrder,
      socket: { symbol: 'socket', result: 'i32', parameters: ['i32', 'i32', 'i32'] },
      bind: { symbol: 'bind', result: 'i32', parameters: ['i32', 'pointer', 'u32'] },
      connect: { symbol: 'connect', result: 'i32', parameters: ['i32', 'pointer', 'u32'] },
      listen: { symbol: 'listen', result: 'i32', parameters: ['i32', 'i32'] },
      accept: { symbol: 'accept', result: 'i32', parameters: ['i32', 'pointer', 'pointer'] },
      send: { symbol: 'send', result: 'ssize', parameters: ['i32', 'pointer', 'size', 'i32'] },
      recv: { symbol: 'recv', result: 'ssize', parameters: ['i32', 'pointer', 'size', 'i32'] },
      sendto: { symbol: 'sendto', result: 'ssize', parameters: ['i32', 'pointer', 'size', 'i32', 'pointer', 'u32'] },
      recvfrom: { symbol: 'recvfrom', result: 'ssize', parameters: ['i32', 'pointer', 'size', 'i32', 'pointer', 'pointer'] },
      shutdown: { symbol: 'shutdown', result: 'i32', parameters: ['i32', 'i32'] },
      close: { symbol: 'close', result: 'i32', parameters: ['i32'] },
      getsockname: { symbol: 'getsockname', result: 'i32', parameters: ['i32', 'pointer', 'pointer'] },
      getpeername: { symbol: 'getpeername', result: 'i32', parameters: ['i32', 'pointer', 'pointer'] },
      getsockopt: { symbol: 'getsockopt', result: 'i32', parameters: ['i32', 'i32', 'i32', 'pointer', 'pointer'] },
      setsockopt: { symbol: 'setsockopt', result: 'i32', parameters: ['i32', 'i32', 'i32', 'pointer', 'u32'] },
      poll: { symbol: 'poll', result: 'i32', parameters: ['pointer', 'ulong', 'i32'] },
      fcntl: { symbol: 'fcntl', result: 'i32', parameters: ['i32', 'i32', 'i32'], variadic: 2 },
      inet_pton: { symbol: 'inet_pton', result: 'i32', parameters: ['i32', 'cstring', 'pointer'] },
      inet_ntop: { symbol: 'inet_ntop', result: 'pointer', parameters: ['i32', 'pointer', 'pointer', 'u32'] },
    },
    layouts: { ...addressLayouts, pollfd: { byteLength: 8, fields: {
      fd: { type: 'i32', offset: 0 }, events: { type: 'i16', offset: 4 }, revents: { type: 'i16', offset: 6 },
    } } },
  },
  windows: {
    library: 'ws2_32.dll',
    target: { architecture: 'x86_64', pointerSize: 8, longSize: 4 },
    functions: {
      ...byteOrder,
      WSAStartup: { symbol: 'WSAStartup', result: 'i32', parameters: ['u16', 'pointer'] },
      WSACleanup: { symbol: 'WSACleanup', result: 'i32', parameters: [] },
      WSAGetLastError: { symbol: 'WSAGetLastError', result: 'i32', parameters: [], clearErrors: false },
      socket: { symbol: 'socket', result: 'u64', parameters: ['i32', 'i32', 'i32'] },
      bind: { symbol: 'bind', result: 'i32', parameters: ['u64', 'pointer', 'i32'] },
      connect: { symbol: 'connect', result: 'i32', parameters: ['u64', 'pointer', 'i32'] },
      listen: { symbol: 'listen', result: 'i32', parameters: ['u64', 'i32'] },
      accept: { symbol: 'accept', result: 'u64', parameters: ['u64', 'pointer', 'pointer'] },
      send: { symbol: 'send', result: 'i32', parameters: ['u64', 'pointer', 'i32', 'i32'] },
      recv: { symbol: 'recv', result: 'i32', parameters: ['u64', 'pointer', 'i32', 'i32'] },
      sendto: { symbol: 'sendto', result: 'i32', parameters: ['u64', 'pointer', 'i32', 'i32', 'pointer', 'i32'] },
      recvfrom: { symbol: 'recvfrom', result: 'i32', parameters: ['u64', 'pointer', 'i32', 'i32', 'pointer', 'pointer'] },
      shutdown: { symbol: 'shutdown', result: 'i32', parameters: ['u64', 'i32'] },
      closesocket: { symbol: 'closesocket', result: 'i32', parameters: ['u64'] },
      getsockname: { symbol: 'getsockname', result: 'i32', parameters: ['u64', 'pointer', 'pointer'] },
      getpeername: { symbol: 'getpeername', result: 'i32', parameters: ['u64', 'pointer', 'pointer'] },
      getsockopt: { symbol: 'getsockopt', result: 'i32', parameters: ['u64', 'i32', 'i32', 'pointer', 'pointer'] },
      setsockopt: { symbol: 'setsockopt', result: 'i32', parameters: ['u64', 'i32', 'i32', 'pointer', 'i32'] },
      WSAPoll: { symbol: 'WSAPoll', result: 'i32', parameters: ['pointer', 'u32', 'i32'] },
      ioctlsocket: { symbol: 'ioctlsocket', result: 'i32', parameters: ['u64', 'i32', 'pointer'] },
      inet_pton: { symbol: 'inet_pton', result: 'i32', parameters: ['i32', 'cstring', 'pointer'] },
      inet_ntop: { symbol: 'inet_ntop', result: 'pointer', parameters: ['i32', 'pointer', 'pointer', 'size'] },
    },
    layouts: { ...addressLayouts,
      pollfd: { byteLength: 16, fields: {
        fd: { type: 'u64', offset: 0 }, events: { type: 'i16', offset: 8 }, revents: { type: 'i16', offset: 10 },
      } },
      wsaData: { byteLength: 408, fields: {
        version: { type: 'u16', offset: 0 }, highVersion: { type: 'u16', offset: 2 },
      } },
    },
  },
};

export const networkConstants = {
  linux: Object.freeze({
    AF_INET: 2, AF_INET6: 10, SOCK_STREAM: 1, SOCK_DGRAM: 2, IPPROTO_TCP: 6, IPPROTO_UDP: 17,
    SHUT_RD: 0, SHUT_WR: 1, SHUT_RDWR: 2, SOL_SOCKET: 1, SO_REUSEADDR: 2, SO_ERROR: 4, SO_TYPE: 3,
    POLLIN: 1, POLLOUT: 4, POLLERR: 8, POLLHUP: 16, MSG_PEEK: 2, MSG_DONTWAIT: 0x40,
    MSG_NOSIGNAL: 0x4000, F_GETFL: 3, F_SETFL: 4, O_NONBLOCK: 0x800,
  }),
  windows: Object.freeze({
    AF_INET: 2, AF_INET6: 23, SOCK_STREAM: 1, SOCK_DGRAM: 2, IPPROTO_TCP: 6, IPPROTO_UDP: 17,
    SD_RECEIVE: 0, SD_SEND: 1, SD_BOTH: 2, SOL_SOCKET: 0xffff, SO_REUSEADDR: 4, SO_ERROR: 0x1007, SO_TYPE: 0x1008,
    POLLIN: 0x300, POLLOUT: 0x10, POLLERR: 1, POLLHUP: 2, MSG_PEEK: 2,
    FIONBIO: 0x8004667e | 0, INVALID_SOCKET: 18446744073709551615n, SOCKET_ERROR: -1,
  }),
};
