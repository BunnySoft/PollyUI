import { alloc } from 'sysrt:ffi';
import { fileConstants as C } from './sysrt/bindings/files.mjs';
import { raw, call, status, usingFD, errors, failure } from './desktop/shared/native-files.mjs';

function readIcon(entry) {
  const bundle = entry.id.startsWith('bundle:') && entry.icon.startsWith(entry.path + '/');
  const absolute = entry.id.endsWith('.desktop') && entry.icon.startsWith('/');
  if ((!bundle && !absolute) || !/\.(png|jpe?g)$/i.test(entry.icon))
    throw new TypeError('A registered bundle or absolute desktop-entry PNG/JPEG icon is required');
  const parts = entry.icon.slice(1).split('/');
  if (!entry.icon.startsWith('/') || parts.some(part => !part || part === '.' || part === '..' || part.includes('\0')))
    throw new TypeError('Invalid managed-bundle icon path');
  let parent = Number(call('open', C.currentDirectory, '/', C.readOnly | C.directory | C.closeOnExec, 0));
  try {
    for (const part of parts.slice(0, -1)) {
      const next = Number(call('open', parent, part, C.readOnly | C.directory | C.noFollow | C.closeOnExec, 0));
      const previous = parent; parent = next;
      call('close', previous);
    }
    return usingFD(Number(call('open', parent, parts.at(-1),
      C.readOnly | C.noFollow | C.nonblock | C.closeOnExec, 0)), fd => {
      const before = status(fd);
      if ((before.mode & C.typeMask) !== C.regular || before.size < 1n || before.size > 4n * 1024n * 1024n)
        throw new TypeError('Bundle icons must be regular bitmaps of at most 4 MiB');
      const size = Number(before.size), buffer = alloc(size + 1);
      try {
        for (let offset = 0; offset < size;) {
          const view = buffer.slice(offset, size - offset);
          let result;
          try { result = raw('read', fd, view, size - offset); } finally { view.close(); }
          if (result.value < 0 && result.errno === 4) continue;
          if (result.value < 0) throw failure(errors[result.errno] ?? 'ERR_OS_' + result.errno, 'read bundle icon');
          if (!result.value) throw new Error('Bundle icon was truncated');
          offset += Number(result.value);
        }
        const after = status(fd);
        if (after.size !== before.size || after.mtimeSeconds !== before.mtimeSeconds ||
            after.mtimeNanos !== before.mtimeNanos || after.ctimeSeconds !== before.ctimeSeconds ||
            after.ctimeNanos !== before.ctimeNanos)
          throw new Error('Bundle icon changed during loading');
        return new Uint8Array(buffer.read(size));
      } finally { buffer.close(); }
    });
  } finally { call('close', parent); }
}

export function createDesktopIconResources(decode) {
  const assets = new Map();
  let pixels = 0;
  return {
    retain(entries) {
      const wanted = new Set(entries.map(entry => entry.icon));
      for (const [path, bitmap] of assets) if (!wanted.has(path)) {
        pixels -= bitmap.width * bitmap.height; bitmap.close(); assets.delete(path);
      }
    },
    load(entry) {
      if (assets.has(entry.icon)) return assets.get(entry.icon).key;
      const remaining = Math.min(1024 * 1024, 8 * 1024 * 1024 - pixels);
      if (remaining < 1) throw new Error('Desktop icon bitmap budget exhausted');
      const bitmap = decode(readIcon(entry), remaining);
      if (bitmap.width > 1024 || bitmap.height > 1024) {
        bitmap.close(); throw new Error('Desktop icons cannot exceed 1024 pixels per side');
      }
      assets.set(entry.icon, bitmap); pixels += bitmap.width * bitmap.height;
      return bitmap.key;
    },
    close() { for (const bitmap of assets.values()) bitmap.close(); assets.clear(); pixels = 0; },
  };
}
