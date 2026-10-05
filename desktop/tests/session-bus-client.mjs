document.body.textContent = 'Private session bus fixture';
const helper = application.arguments[0];
const pid = desktop.spawnApplication([helper], '', 'session-bus-probe');
desktop.onExit = event => {
  if (event.pid !== pid) return;
  if (event.status !== 0) {
    console.error('FAIL: Session bus probe failed: ' + event.status);
    window.quit();
    return;
  }
  console.log('PASS: launched application inherits the private session bus');
  if (application.arguments[1] !== 'hold') window.quit();
};
setTimeout(() => {
  console.error('FAIL: private bus fixture timed out');
  window.quit();
}, 30000);
