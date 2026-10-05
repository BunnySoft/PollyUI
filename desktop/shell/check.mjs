import { createDesktopShell } from './desktop/shell/shell.mjs';

const shell = createDesktopShell().start();
try {
  const deadline = Date.now() + 15000;
  while (true) {
    const state = shell.getState();
    if (state.error) throw new Error(state.error);
    const audio = desktop.audioAvailable ? desktop.audioState() : null;
    if (audio?.error) throw new Error(audio.error);
    if (state.outputs.length && shell.getSurfaces().length && (!audio || audio.ready)) break;
    if (Date.now() >= deadline) throw new Error('Installed desktop did not become ready');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await new Promise(resolve => setTimeout(resolve, 150));
  console.log('PASS: installed PollyDesktop session ready');
} finally {
  shell.stop();
  window.quit();
}
