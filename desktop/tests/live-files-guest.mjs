function check(value, message) {
  if (!value) throw new Error(message);
}
try {
  check(Object.keys(desktop).length === 1 && desktop.fileSystem,
    'ordinary guest application must not receive Shell management');
  const fs = desktop.fileSystem, parent = application.arguments[0];
  const directory = fs.stat(parent, false);
  const entry = fs.writeText(parent, 'sdk-check.txt', 'Alpha.6 native JS file read/write\n', directory.identity);
  const read = fs.readText(entry.path, entry.identity);
  check(read.text === 'Alpha.6 native JS file read/write\n', 'native file read/write bytes');
  const observed = fs.observeText(entry.path);
  check(observed.identity.startsWith('sha256:'), 'actual native crypto observation');
  const listing = fs.listDirectory(parent, null);
  check(listing.entries.some(item => item.name === 'sdk-check.txt'), 'native directory enumeration');
  console.log('POLLY_VM_FILES_NATIVE_OK');
} catch (error) {
  console.error('POLLY_VM_FILES_NATIVE_FAILED: ' + String(error));
}
window.quit();
