import { validateBundleRecord, validateBundleId } from './desktop/shared/app-bundle.mjs';

export function bundleCatalog(files, manager, canExecute, report) {
  if (!Array.isArray(files)) throw new TypeError('Managed application catalog must be an array');
  const seen = new Set();
  const result = [];
  for (const file of files) {
    try {
      validateBundleId(file.id);
      if (seen.has(file.id)) throw new Error('Duplicate managed application ID');
      seen.add(file.id);
      if (typeof file.store !== 'string' || !file.store.startsWith('/') || file.store.includes('\0'))
        throw new Error('Invalid managed application store');
      if (typeof file.contents !== 'string' || file.contents.length > 192 * 1024)
        throw new Error('Managed application record exceeds its size limit');
      const record = validateBundleRecord(JSON.parse(file.contents));
      const { digest, manifest } = record.current;
      if (manifest.id !== file.id) throw new Error('Application record identity mismatch');
      const root = file.store + '/objects/' + digest;
      result.push({ id: 'bundle:' + manifest.id, path: root, name: manifest.name,
        comment: 'Managed application ' + manifest.version, genericName: '',
        icon: manifest.icon ? root + '/' + manifest.icon : '', terminal: false,
        categories: [], keywords: [manifest.id, manifest.version], cwd: '',
        argv: [manager, 'run', manifest.id, digest],
        unavailable: canExecute(manager) ? '' : 'Managed application launcher is unavailable' });
    } catch (error) {
      report('[applications] Invalid managed application ' + String(file?.id) + ': ' + String(error));
    }
  }
  return result;
}
