const mode = application.arguments[0];
if (mode === 'settings') {
  const count = Number(application.arguments[1]);
  const { openShellConfiguration } = await import('./desktop/shell/configuration-native.mjs');
  const configuration = openShellConfiguration();
  if (count === 1) {
    configuration.update({ theme: { id: 'bigsur', filesEnabled: true }, workspace: {
      version: 1, names: ['Persistent workspace', 'Two', 'Three', 'Four'], active: 0,
    } });
  } else if (configuration.snapshot.theme.id !== 'bigsur' ||
      configuration.snapshot.workspace.names[0] !== 'Persistent workspace') {
    throw new Error('Shell settings did not survive reboot or slot change');
  }
  configuration.close();
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
