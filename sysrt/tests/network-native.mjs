import { alloc, platform } from 'sysrt:ffi';
import { createNetworkApi, constants as C } from './sysrt/sdk/js/network.mjs';
import { loadBindings } from './sysrt/sdk/js/native.mjs';

const windows = platform === 'windows', api = createNetworkApi();
const oracle = loadBindings({ library: fixtureLibrary, functions: {
  layout: { symbol: 'sr_network_layout', result: 'size', parameters: ['i32'] },
  constant: { symbol: 'sr_network_constant', result: 'i64', parameters: ['i32'] },
}});
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const records = [], buffers = [], sockets = new Set();
let started = false;
function check(value, message) { if (!value) throw new Error(message); }
function ok(result, message) {
  if (result.value < 0 || (windows && result.value === C.INVALID_SOCKET))
    throw new Error(message + ': error=' + (windows ? api.WSAGetLastError().value : result.errno));
  return result.value;
}
function record(name) { const value = api.createRecord(name); records.push(value); return value; }
function buffer(size) { const value = alloc(size); buffers.push(value); return value; }
function u32(pointer, value) {
  const bytes = new ArrayBuffer(4); new DataView(bytes).setUint32(0, value, littleEndian); pointer.write(bytes);
}
function scalar(pointer) { return new DataView(pointer.read(4)).getUint32(0, littleEndian); }
function address() {
  const value = record('sockaddrIn');
  value.write({ family: C.AF_INET, port: 0, address: api.htonl(0x7f000001).value });
  return value;
}
function socket(type) {
  const value = ok(api.socket(C.AF_INET, type, 0), 'Socket create');
  sockets.add(value); return value;
}
function bound(type) {
  const fd = socket(type), value = address(), length = buffer(4);
  ok(api.bind(fd, value.pointer, 16), 'Bind private loopback endpoint');
  u32(length, 16); ok(api.getsockname(fd, value.pointer, length), 'Observe assigned endpoint');
  check(scalar(length) === 16 && api.ntohs(value.read().port).value > 0, 'Kernel assigns an ephemeral port');
  return { fd, address: value };
}
function ready(fd, timeout) {
  const wait = record('pollfd');
  wait.write({ fd, events: C.POLLIN, revents: 0 });
  const result = windows ? api.WSAPoll(wait.pointer, 1, timeout) : api.poll(wait.pointer, 1, timeout);
  const count = Number(ok(result, 'Readiness wait'));
  return { count, events: wait.read().revents };
}

try {
  const expected = [16, 0, 2, 4, 28, 0, 2, 4, 8, 24,
    windows ? 16 : 8, 0, windows ? 8 : 4, windows ? 10 : 6, 4, windows ? 8 : 4, windows ? 408 : 0];
  expected.forEach((value, index) =>
    check(Number(oracle.call('layout', index).value) === value, 'Measured socket ABI field ' + index));
  const values = [C.AF_INET, C.AF_INET6, C.SOCK_STREAM, C.SOCK_DGRAM, C.IPPROTO_TCP, C.IPPROTO_UDP,
    windows ? C.SD_RECEIVE : C.SHUT_RD, windows ? C.SD_SEND : C.SHUT_WR, windows ? C.SD_BOTH : C.SHUT_RDWR,
    C.SOL_SOCKET, C.SO_REUSEADDR, C.SO_ERROR, C.SO_TYPE, C.POLLIN, C.POLLOUT, C.POLLERR, C.POLLHUP, C.MSG_PEEK,
    ...(windows ? [C.FIONBIO] : [C.MSG_DONTWAIT, C.MSG_NOSIGNAL, C.F_GETFL, C.F_SETFL, C.O_NONBLOCK])];
  values.forEach((value, index) =>
    check(oracle.call('constant', index).value === BigInt(value), 'Measured network constant ' + index));
  if (windows) {
    const data = record('wsaData');
    check(api.WSAStartup(0x0202, data.pointer).value === 0, 'Explicit Winsock startup');
    started = true;
    check(data.read().version === 0x0202, 'Native negotiated Winsock version');
  }
  const binaryAddress = buffer(16), text = buffer(64);
  const parse = api.inet_pton, format = api.inet_ntop;
  check(parse(C.AF_INET, '127.0.0.1', binaryAddress).value === 1, 'Native IPv4 parse');
  const output = format(C.AF_INET, binaryAddress, text, 64).value;
  check(output !== null, 'Native IPv4 format pointer');
  try { check(output.readString(64) === '127.0.0.1', 'Native address formatting uses the supplied output buffer'); }
  finally { output.close(); }
  check(parse(C.AF_INET, 'not-an-address', binaryAddress).value === 0, 'Native parse failure stays a return value');
  check(parse(C.AF_INET6, '::1', binaryAddress).value === 1, 'Native IPv6 parse');
  const ipv6 = record('sockaddrIn6');
  ipv6.write({ family: C.AF_INET6, address: new Uint8Array(binaryAddress.read(16)) });
  check(ipv6.read().address[15] === 1, 'IPv6 record contains native address bytes');

  const server = bound(C.SOCK_STREAM), option = buffer(4), length = buffer(4);
  u32(option, 1);
  ok(api.setsockopt(server.fd, C.SOL_SOCKET, C.SO_REUSEADDR, option, 4), 'Native socket option set');
  u32(length, 4);
  ok(api.getsockopt(server.fd, C.SOL_SOCKET, C.SO_TYPE, option, length), 'Native socket option query');
  check(scalar(option) === C.SOCK_STREAM && scalar(length) === 4, 'Native socket type and option size');
  ok(api.listen(server.fd, 4), 'Listen');
  const client = socket(C.SOCK_STREAM);
  ok(api.connect(client, server.address.pointer, 16), 'Connect to the private listener');
  check(ready(server.fd, 5000).count === 1, 'Listener readiness');
  const accepted = ok(api.accept(server.fd, null, null), 'Accept');
  sockets.add(accepted);
  const peer = address();
  u32(length, 16); ok(api.getpeername(client, peer.pointer, length), 'Peer endpoint query');
  check(peer.read().port === server.address.read().port, 'Connected peer uses the assigned listener');
  const payload = new Uint8Array([0, 255, 127, 128, 0, 42, 7, 9]), send = buffer(payload.length), received = buffer(payload.length);
  send.write(payload.buffer);
  for (let at = 0; at < payload.length;) {
    const view = send.slice(at, payload.length - at);
    try {
      const count = Number(ok(api.send(client, view, payload.length - at, 0), 'TCP send'));
      check(count > 0, 'Native send progress'); at += count;
    } finally { view.close(); }
  }
  const readable = ready(accepted, 5000);
  check(readable.count === 1 && (readable.events & C.POLLIN), 'Native TCP read-ready flags');
  const peeked = Number(ok(api.recv(accepted, received, payload.length, C.MSG_PEEK), 'TCP peek'));
  check(peeked > 0 && new Uint8Array(received.read(peeked)).join(',') === payload.slice(0, peeked).join(','),
    'Native peek returns bytes without consuming the stream');
  for (let at = 0; at < payload.length;) {
    const view = received.slice(at, payload.length - at);
    try {
      const count = Number(ok(api.recv(accepted, view, payload.length - at, 0), 'TCP recv'));
      check(count > 0, 'Native recv progress'); at += count;
    } finally { view.close(); }
  }
  check(new Uint8Array(received.read(payload.length)).join(',') === payload.join(','), 'Binary TCP bytes, including NUL and invalid UTF-8');
  ok(api.shutdown(client, windows ? C.SD_SEND : C.SHUT_WR), 'Half-close send direction');
  check(ready(accepted, 5000).count === 1 && Number(api.recv(accepted, received, payload.length, 0).value) === 0,
    'Native EOF after half-close');

  const receiver = bound(C.SOCK_DGRAM), sender = socket(C.SOCK_DGRAM);
  if (windows) {
    u32(option, 1); ok(api.ioctlsocket(receiver.fd, C.FIONBIO, option), 'Native nonblocking ioctl');
  } else {
    const flags = ok(api.fcntl(receiver.fd, C.F_GETFL, 0), 'Native descriptor flags');
    ok(api.fcntl(receiver.fd, C.F_SETFL, flags | C.O_NONBLOCK), 'Native nonblocking descriptor mode');
  }
  check(ready(receiver.fd, 0).count === 0, 'Zero-time readiness wait preserves native timeout');
  const pending = api.recv(receiver.fd, received, payload.length, 0);
  check(Number(pending.value) === -1, 'Nonblocking receive has no synthetic success');
  check(windows ? api.WSAGetLastError().value === 10035 : pending.errno === 11, 'Native would-block error');
  check(Number(ok(api.sendto(sender, send, payload.length, 0, receiver.address.pointer, 16), 'UDP sendto')) === payload.length,
    'Native datagram send');
  check(ready(receiver.fd, 5000).count === 1, 'Datagram read readiness');
  u32(length, 16);
  check(Number(ok(api.recvfrom(receiver.fd, received, payload.length, 0, peer.pointer, length), 'UDP recvfrom')) === payload.length,
    'Native datagram receive');
  check(new Uint8Array(received.read(payload.length)).join(',') === payload.join(','), 'Binary UDP bytes');
  const local = address();
  u32(length, 16); ok(api.getsockname(sender, local.pointer, length), 'Datagram sender endpoint');
  check(peer.read().port === local.read().port, 'recvfrom reports the actual sender');
  const invalid = api.socket(-1, C.SOCK_STREAM, 0);
  check(windows ? invalid.value === C.INVALID_SOCKET : invalid.value === -1, 'Native invalid socket result');
  check(windows ? api.WSAGetLastError().value !== 0 : invalid.errno !== 0, 'OS error remains observable');
} finally {
  const failures = [];
  for (const fd of sockets) {
    const result = windows ? api.closesocket(fd) : api.close(fd);
    if (result.value !== 0) failures.push('socket close: ' + (windows ? api.WSAGetLastError().value : result.errno));
  }
  for (const value of [...records, ...buffers]) value.close();
  if (started && api.WSACleanup().value !== 0) failures.push('Winsock cleanup');
  api.dispose(); oracle.close();
  if (failures.length) throw new Error(failures.join('; '));
}
