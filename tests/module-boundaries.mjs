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

test('filesystem provider builds without a scripting or GUI projection', () => {
  for (const path of ['sysrt/providers/linux/files.h', 'sysrt/providers/linux/files.c']) {
    assert.doesNotMatch(read(path), /\b(?:JSContext|JSValue|JSRuntime|pu_files_install|PU_FILES_CORE_ONLY)\b|quickjs\.h|SDL3|skia/);
  }
  const build = read('sysrt/CMakeLists.txt');
  assert.match(build, /project\(PollySystemRT LANGUAGES C\)/);
  assert.match(build, /if \(TARGET qjs\)/);
  assert.doesNotMatch(build, /yogacore|pollyui-engine|gui\/src|desktop\/native/);
  assert.match(read('sysrt/projection/quickjs/files.c'), /pu_files_locations\(&locations\)/);
  assert.doesNotMatch(read('sysrt/projection/quickjs/files.c'), /\bgetenv\s*\(/);
});

test('CLI and legacy desktop composition remain outside the GUI engine', () => {
  assert.match(read('desktop/launcher/main.c'), /pu_application_run\(&options\)/);
  assert.doesNotMatch(read('desktop/launcher/main.c'), /\bJS_(?:NewClass|NewCFunction|SetOpaque)\b/);
  assert.equal(existsSync(new URL('src/desktop/applications.c', root)), false);
  assert.ok(existsSync(new URL('desktop/native/applications.c', root)));
  assert.doesNotMatch(cmake, /src\/desktop\/|host\/win32\/window\.h/);
  assert.match(cmake, /sysrt\/projection\/quickjs\/files\.c/);
  assert.match(read('desktop/launcher/launcher.c'), /pu_gui_run\(&config\)/);
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
