const [runtime, fixture] = application.arguments;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const exits = new Map();
desktop.onExit = result => exits.set(result.pid, result.status);
async function run() {
  const pid = desktop.spawnApplication([runtime, '--desktop', '--app-id',
    'org.pollyui.install-readonly-native-fixture', fixture], '', 'ordinary private readonly window fixture');
  const deadline = Date.now() + 60000;
  while (!exits.has(pid)) {
    if (Date.now() > deadline) throw new Error('Ordinary readonly window fixture did not exit');
    await wait(20);
  }
  if (exits.get(pid) !== 0) throw new Error('Ordinary readonly window exited ' + exits.get(pid));
  console.log('PASS: separate ordinary readonly window process exited');
  window.close();
}
run().catch(error => {
  console.error('NATIVE READONLY ORDINARY WINDOW FAIL: ' + error);
  window.quit();
});
