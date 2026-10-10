import { alloc, platform } from 'sysrt:ffi';
import { createProcessApi, constants as C } from './sysrt/sdk/js/process.mjs';
import { createCStringArray } from './sysrt/sdk/js/memory.mjs';
import { loadBindings } from './sysrt/sdk/js/native.mjs';

const api = createProcessApi();
const oracle = loadBindings({ library: fixtureLibrary, functions: {
  layout: { symbol: 'sr_process_layout', result: 'size', parameters: ['i32'] },
} });
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
function check(value, message) { if (!value) throw new Error(message); }

if (platform === 'linux') {
  check(oracle.call('layout', 0).value === 4n, 'Native PID/status scalar width');
  check(api.getpid().value === expectedProcessId && api.getppid().value > 0, 'Actual process and parent IDs');
  check(api.getpgid(0).value > 0 && api.getsid(0).value > 0, 'Native group and session observations');
  check(api.getuid().value === api.geteuid().value && api.getgid().value === api.getegid().value,
    'Real/effective IDs are observed, not policy-gated');
  const pidBuffer = alloc(4), status = alloc(4);
  let owned = 0;
  function spawn(arguments_, environment = []) {
    const argv = createCStringArray([processChild, ...arguments_]), envp = createCStringArray(environment);
    try {
      const result = api.posix_spawn(pidBuffer, processChild, null, null, argv.pointer, envp.pointer);
      check(result.value === 0, 'Native spawn return code: ' + result.value);
      owned = new DataView(pidBuffer.read(4)).getInt32(0, littleEndian);
      check(owned > 0, 'Spawn writes a real child PID');
      return owned;
    } finally { argv.close(); envp.close(); }
  }
  function reap() {
    let result;
    do { result = api.waitpid(owned, status, 0); } while (result.value === -1 && result.errno === 4);
    check(result.value === owned, 'Wait reaps the owned child: errno=' + result.errno);
    owned = 0;
    return new DataView(status.read(4)).getInt32(0, littleEndian);
  }
  try {
    spawn(['--probe', 'literal %u; $(not a shell)'], ['SYSRT_PROCESS_VALUE=explicit environment']);
    const exited = reap();
    check((exited & 127) === 0 && ((exited >> 8) & 255) === 19, 'Literal argv and explicit envp reach a real child');
    spawn(['--linger']);
    check(api.waitpid(owned, status, C.WNOHANG).value === 0, 'Nonblocking wait preserves native pending result');
    check(api.kill(owned, 0).value === 0, 'Native signal-zero existence check');
    check(api.kill(owned, C.SIGTERM).value === 0, 'Only the owned child is terminated');
    check((reap() & 127) === C.SIGTERM, 'Native signal wait status');
    const argv = createCStringArray(['missing']), envp = createCStringArray([]);
    try {
      check(api.posix_spawn(pidBuffer, '/sysrt-no-such-executable', null, null, argv.pointer, envp.pointer).value === 2,
        'posix_spawn returns its own ENOENT error code, not -1/errno');
      check(api.posix_spawnp(pidBuffer, 'sysrt-no-such-executable', null, null, argv.pointer, envp.pointer).value === 2,
        'posix_spawnp exposes native search failure');
    } finally { argv.close(); envp.close(); }
    const wait = api.waitpid(-1, status, C.WNOHANG);
    check(wait.value === -1 && wait.errno === 10, 'No children preserves native ECHILD');
  } finally {
    if (owned) { api.kill(owned, C.SIGKILL); reap(); }
    pidBuffer.close(); status.close(); api.dispose();
  }
} else if (platform === 'windows') {
  [104, 24, 0, 8, 16, 20].forEach((size, index) =>
    check(Number(oracle.call('layout', index).value) === size, 'Measured Windows process ABI field ' + index));
  function wide(text) {
    const bytes = new Uint16Array(text.length + 1);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    const buffer = alloc(bytes.byteLength); buffer.write(bytes.buffer);
    return buffer;
  }
  oracle.close();
  check(api.GetCurrentProcessId().value === expectedProcessId, 'Actual Windows process ID');
  const startup = api.createRecord('startupInfo'), information = api.createRecord('processInfo'), code = alloc(4);
  const executable = wide(processChild);
  let processHandle = null, threadHandle = null, ownedRunning = false;
  function spawn(option) {
    const command = wide('"' + processChild + '" ' + option);
    try {
      startup.write({ size: 104 });
      const result = api.CreateProcessW(executable, command, null, null, 0, 0, null, null,
        startup.pointer, information.pointer);
      check(result.value !== 0, 'CreateProcessW succeeds: error=' + result.systemError);
      processHandle = information.pointer.readPointer();
      threadHandle = information.pointer.readPointer(8);
      ownedRunning = true;
      check(processHandle !== null && threadHandle !== null && information.read().processId > 0,
        'Native output handle fields and IDs are readable');
    } finally { command.close(); }
  }
  function closeHandles() {
    for (const handle of [threadHandle, processHandle]) {
      if (handle) { check(api.CloseHandle(handle).value !== 0, 'Explicit OS handle release'); handle.close(); }
    }
    threadHandle = processHandle = null;
  }
  try {
    spawn('--exit');
    check(api.WaitForSingleObject(processHandle, C.INFINITE).value === C.WAIT_OBJECT_0, 'Native process wait');
    ownedRunning = false;
    check(api.GetExitCodeProcess(processHandle, code).value !== 0 &&
      new DataView(code.read(4)).getUint32(0, littleEndian) === 23, 'Actual native exit code');
    closeHandles();
    spawn('--linger');
    check(api.WaitForSingleObject(processHandle, 0).value === C.WAIT_TIMEOUT, 'Zero-time wait returns native timeout');
    const opened = api.OpenProcess(C.PROCESS_QUERY_LIMITED_INFORMATION, 0, information.read().processId);
    check(opened.value !== null, 'Open the known owned process');
    try { check(api.GetExitCodeProcess(opened.value, code).value !== 0, 'Query known process handle'); }
    finally { check(api.CloseHandle(opened.value).value !== 0, 'Close queried handle'); opened.value.close(); }
    check(api.TerminateProcess(processHandle, 42).value !== 0, 'Terminate only the owned process');
    check(api.WaitForSingleObject(processHandle, C.INFINITE).value === C.WAIT_OBJECT_0, 'Wait after termination');
    ownedRunning = false;
    check(api.GetExitCodeProcess(processHandle, code).value !== 0 &&
      new DataView(code.read(4)).getUint32(0, littleEndian) === 42, 'Termination exit code remains native');
    closeHandles();
    const missing = wide(processChild + '.missing'), command = wide('missing');
    try {
      const result = api.CreateProcessW(missing, command, null, null, 0, 0, null, null,
        startup.pointer, information.pointer);
      check(result.value === 0 && result.systemError === 2, 'CreateProcessW preserves missing-file error');
    } finally { missing.close(); command.close(); }
  } finally {
    if (ownedRunning && processHandle) {
      api.TerminateProcess(processHandle, 98);
      api.WaitForSingleObject(processHandle, C.INFINITE);
    }
    closeHandles(); executable.close(); startup.close(); information.close(); code.close(); api.dispose();
  }
}
