export function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
}

export function fileType(entry) {
  if (entry.type === 'directory') return 'Folder';
  if (entry.type === 'symlink') return 'Symbolic link';
  if (entry.type !== 'file') return 'Special file';
  const extension = entry.name.includes('.') ? entry.name.split('.').at(-1) : '';
  return extension && extension.length <= 12 ? extension.toUpperCase() + ' file' : 'File';
}

export function formatModified(milliseconds) {
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return 'Outside date range';
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

export function visibleEntries(state) {
  const query = (state.filter || '').toLowerCase();
  const key = state.sort?.key || 'name', direction = state.sort?.direction || 1;
  const value = entry => key === 'type' ? fileType(entry) : key === 'modified' ? entry.mtimeMs :
    key === 'size' ? entry.bytes : entry.name.toLowerCase();
  return (state.snapshot?.entries || []).filter(entry => entry.name.toLowerCase().includes(query)).sort((a, b) => {
    const folders = Number(b.type === 'directory') - Number(a.type === 'directory');
    if (folders) return folders;
    const av = value(a), bv = value(b);
    const compared = typeof av === 'number' ? av - bv : av.localeCompare(bv);
    return direction * compared || a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
  });
}
