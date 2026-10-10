import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const cmake = read('CMakeLists.txt');

test('GUI engine is a library with no system-runtime or desktop composition', () => {
  const build = read('gui/CMakeLists.txt');
  const sources = build.match(/add_library\(pollyui-engine STATIC([\s\S]*?)\n\)/);
  assert.ok(sources);
  assert.match(sources[1], /src\/bridge\/bridge\.c/);
  assert.match(sources[1], /src\/script\/script\.c/);
  assert.match(sources[1], /src\/context\/context\.c/);
  assert.doesNotMatch(sources[1], /desktop\/|sysrt\/|examples\/|main\.c/);
  const commands = cmake.match(/target_(?:sources|link_libraries|include_directories)\(pollyui-engine\b[^)]*\)/g);
  for (const command of commands) {
    assert.doesNotMatch(command, /desktop\/native|polly-bundles|polly-sysrt|SESSION_DBUS|PIPEWIRE|PAM/);
  }
  assert.match(build, /add_executable\(pollyui-playground examples\/playground\/main\.c\)/);
  assert.match(build, /target_link_libraries\(pollyui-playground PRIVATE pollyui-engine\)/);
  assert.doesNotMatch(read('gui/src/context/context.c'), /#include\s+"(?:sysrt|native|desktop)\//);
  assert.doesNotMatch(read('gui/include/pollyui/context.h'), /app_id|greeter_mode|desktop_mode/);
});

test('shared Host interface and SDL surface adapter have no desktop service dependency', () => {
  assert.ok(existsSync(new URL('gui/include/pollyui/window.h', root)));
  assert.equal(existsSync(new URL('src/host/win32/window.h', root)), false);
  for (const path of ['gui/include/pollyui/window.h', 'gui/src/host/sdl/layer_shell.h', 'gui/src/host/sdl/layer_shell.c',
    'gui/src/host/sdl/window_sdl.c', 'gui/src/host/win32/window.c']) {
    const source = read(path);
    assert.doesNotMatch(source, /#include\s+"(?:desktop|native|sysrt)\//);
    assert.doesNotMatch(source, /\bpu_(?:lock_client_surface|input_client_popup)\s*\(/);
  }
  assert.match(read('gui/src/host/sdl/layer_shell.c'), /lock_surface_factory\(layer->native, output\)/);
  assert.match(read('desktop/launcher/launcher.c'), /pu_layer_set_role_factories\(NULL, NULL\)/);
});

test('filesystem is a JS/config SDK with no domain-specific native provider or projection', () => {
  for (const path of ['sysrt/providers/linux/files.h', 'sysrt/providers/linux/files.c',
    'sysrt/projection/quickjs/files.c', 'sysrt/projection/quickjs/files.h'])
    assert.equal(existsSync(new URL(path, root)), false, path);
  const build = read('sysrt/CMakeLists.txt');
  assert.match(build, /project\(PollySystemRT LANGUAGES C\)/);
  assert.match(build, /if \(TARGET qjs\)/);
  assert.doesNotMatch(build, /yogacore|pollyui-engine|gui\/src|desktop\/native/);
  assert.doesNotMatch(build, /polly-sysrt-linux-files|providers\/linux\/files/);
  const sdk = read('sysrt/sdk/js/files.mjs');
  assert.match(sdk, /loadNativeApi\(filesBindings\[libc\]\)/);
  assert.doesNotMatch(sdk, /document\.|window\.|desktop\/|pu_files_/);
  assert.doesNotMatch(sdk, /localStorage|ordinary|geteuid|1048576|maxEntries|maxTextBytes|SHA256|sha256/);
  assert.match(read('sysrt/bindings/files.mjs'), /symbol: 'statx'/);
  const service = read('desktop/shared/file-system.mjs');
  assert.match(read('desktop/shared/native-files.mjs'), /createFileSystem\(\)/);
  assert.match(service, /COUNT = 1024, TEXT = 1048576/);
  assert.match(read('desktop/launcher/services.mjs'), /fileSystem.*from '\.\/desktop\/shared\/file-system\.mjs'/);
});

test('theme file policy is JS over FileSystem and bitmap decoding belongs to GUI', () => {
  for (const path of ['desktop/native/theme-files.c', 'desktop/native/theme-files.h'])
    assert.equal(existsSync(new URL(path, root)), false, path);
  assert.doesNotMatch(cmake + read('desktop/native/windows.c'), /pu_theme_files_|native\/theme-files/);
  const service = read('desktop/shared/theme-resources.mjs');
  assert.match(service, /C\.noFollow/);
  assert.match(service, /authorize\(\)/);
  assert.match(read('desktop/launcher/services.mjs'), /desktop\.windows\.bind\(desktop\)/);
  assert.match(read('desktop/launcher/services.mjs'), /createThemeResources\(windows, globalThis\.createBitmap\)/);
  assert.doesNotMatch(read('gui/src/bridge/bridge.c'), /#include\s+"(?:sysrt|desktop|native)\//);
  assert.match(read('gui/src/bridge/bridge.c'), /JS_GetTypedArrayBuffer/);
});

test('generic FFI has no GUI or domain-specific API dependency', () => {
  const source = read('sysrt/ffi/module.c');
  assert.doesNotMatch(source, /#include\s+"(?:gui|desktop|providers)\//);
  assert.doesNotMatch(source, /\b(?:pu_files_|pu_audio_|pu_network_)/);
  const worker = source.match(/static void async_worker\(void \*user\)[\s\S]*?\n\}/);
  assert.ok(worker);
  assert.doesNotMatch(worker[0], /\bJS_|->ctx/);
  assert.match(source, /ffi_prep_cif/);
  assert.match(source, /ffi_call/);
  assert.match(source, /GetProcAddress/);
  assert.match(source, /dlsym/);
  assert.match(read('sysrt/sdk/js/process.mjs'), /loadNativeApi\(processBindings\[platform\]\)/);
  assert.doesNotMatch(read('sysrt/sdk/js/process.mjs'), /document\.|window\.|desktop/);
  assert.match(cmake, /if \(PU_BUILD_LAUNCHER\)\s+add_subdirectory\(sysrt\)/);
  assert.doesNotMatch(source, /static JSClassID/);
});

test('network SDK maps OS APIs without HTTP, socket ownership or desktop policy', () => {
  const sdk = read('sysrt/sdk/js/network.mjs');
  assert.match(sdk, /loadNativeApi\(networkBindings\[platform\]\)/);
  assert.doesNotMatch(sdk, /localStorage|fetch\(|desktop\/|maxBytes|retry|timeout|WSAStartup\(/);
  const configuration = read('sysrt/bindings/network.mjs');
  assert.match(configuration, /symbol: 'socket'/);
  assert.match(configuration, /symbol: 'WSAPoll'/);
  assert.match(configuration, /WSAGetLastError.*clearErrors: false/);
  assert.doesNotMatch(read('sysrt/ffi/module.c'), /winsock2|WSAGetLastError|ws2_32/);
});

test('D-Bus client stays JS/config-only with explicit connections and library teardown', () => {
  const sdk = read('sysrt/sdk/js/dbus.mjs');
  assert.match(sdk, /loadNativeApi\(dbusBindings\[platform\]\)/);
  assert.match(sdk, /dbus_connection_open_private/);
  assert.match(sdk, /dbus_connection_read_write_dispatch', connection, 0/);
  assert.match(sdk, /export function shutdownDbus\(\)/);
  assert.doesNotMatch(sdk, /document\.|window\.|desktop\/|dbus_bus_get|DBUS_SESSION_BUS_ADDRESS/);
  assert.doesNotMatch(read('sysrt/ffi/module.c'), /#include\s+<dbus\/|\bdbus_/);
  assert.doesNotMatch(read('desktop/launcher/launcher.c'), /\bdbus_shutdown|\bshutdownDbus/);
  const build = read('sysrt/CMakeLists.txt');
  const library = build.match(/add_library\(polly-sysrt-ffi STATIC([\s\S]*?)\)/);
  assert.ok(library);
  assert.doesNotMatch(library[1], /dbus/);
});

test('asynchronous FFI reuses execution primitives and remains VM-thread confined', () => {
  const build = read('sysrt/CMakeLists.txt');
  assert.match(build, /polly-sysrt-ffi PUBLIC qjs polly-execution/);
  assert.match(read('desktop/launcher/launcher.c'), /sr_ffi_register\(ctx, dispatch\)/);
  assert.match(read('desktop/launcher/launcher.c'), /sr_ffi_shutdown\(state->ffi\)/);
  assert.match(read('sysrt/sdk/js/native.mjs'), /callAsync\(name, \.\.\.args\)/);
  assert.match(read('sysrt/ffi/module.c'), /Async calls require managed flat buffers/);
  assert.match(read('sysrt/ffi/module.c'), /ERR_FFI_BUSY/);
  assert.match(read('shared/dispatch.c'), /pu_dispatch_submit/);
});

test('CLI and desktop composition remain outside the GUI engine', () => {
  assert.match(read('desktop/launcher/main.c'), /pu_application_run\(&options\)/);
  assert.doesNotMatch(read('desktop/launcher/main.c'), /\bJS_(?:NewClass|NewCFunction|SetOpaque)\b/);
  assert.equal(existsSync(new URL('src/desktop/applications.c', root)), false);
  assert.ok(existsSync(new URL('desktop/native/applications.c', root)));
  assert.doesNotMatch(cmake, /src\/desktop\/|host\/win32\/window\.h/);
  assert.doesNotMatch(cmake, /sysrt\/projection\/quickjs\/files\.c|polly-files-core-test-adapter/);
  assert.match(read('desktop/launcher/launcher.c'), /pu_gui_run\(&config\)/);
});

test('appearance uses runtime configuration without legacy selection or downgrade paths', () => {
  const shell = read('desktop/shell/shell.mjs');
  assert.match(shell, /native\.configureAppearance\(theme\)/);
  assert.doesNotMatch(shell, /setAppearance|compatibilityTheme|appearanceWarning|startupGeneric/);
  assert.equal(existsSync(new URL('desktop/shell/appearance-compatibility.mjs', root)), false);
  assert.equal(existsSync(new URL('desktop/tests/xp-startup-compatibility.mjs', root)), false);
  assert.doesNotMatch(read('desktop/native/windows.c'), /set_appearance|setAppearance|decoration-themes\.h/);
  assert.doesNotMatch(read('desktop/compositor/decoration.c'), /\bset_theme\b/);
  assert.doesNotMatch(read('desktop/protocols/polly-appearance-v1.xml'), /name="set_theme"/);
  assert.match(cmake, /NAME desktop-xp-startup COMMAND node --test "[^"]*\/xp-startup\.mjs"/);
  assert.doesNotMatch(cmake, /xp-startup-compatibility/);
});

test('application logic does not import views or GUI APIs', () => {
  for (const app of ['files', 'installer']) {
    const directory = `desktop/apps/${app}/logic/`;
    for (const file of readdirSync(new URL(directory, root))) {
      if (!file.endsWith('.mjs')) continue;
      const source = read(directory + file);
      assert.doesNotMatch(source, /from\s+['"][^'"]*(?:gui\/|\/ui\/)|\bdocument\.|\bwindow\.|\.style\./);
    }
  }
});

test('core test selectors name migrated files, not implicit root tests', () => {
  for (const file of read('tools/core-tests.txt').trim().split(/\r?\n/)) {
    assert.ok(/^(gui|sysrt|desktop)\/tests\//.test(file), file);
    assert.ok(existsSync(new URL(file, root)), file);
  }
});
