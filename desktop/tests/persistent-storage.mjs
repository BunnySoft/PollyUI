const mode = application.arguments[0];
if (mode === 'settings') {
  const count = Number(application.arguments[1]);
  if (count === 1) {
    localStorage.setItem('desktop.theme', 'bigsur');
    localStorage.setItem('desktop.workspaces.v1', JSON.stringify({
      version: 1, names: ['Persistent workspace', 'Two', 'Three', 'Four'], active: 0,
    }));
  } else if (localStorage.getItem('desktop.theme') !== 'bigsur' ||
      JSON.parse(localStorage.getItem('desktop.workspaces.v1')).names[0] !== 'Persistent workspace') {
    throw new Error('Shell settings did not survive reboot or slot change');
  }
  console.log('POLLY_SETTINGS_PASS ' + count);
} else {
  if (application.id !== 'org.example.persistence' || typeof desktop !== 'object' ||
      !desktop.fileSystem || Object.keys(desktop).length !== 1 || Object.keys(desktop)[0] !== 'fileSystem')
    throw new Error('Managed application identity or privilege boundary changed');
  const count = Number(localStorage.getItem('launches') || '0') + 1;
  localStorage.setItem('launches', String(count));
  console.log('POLLY_APPDATA_PASS ' + count);
}
window.close();
