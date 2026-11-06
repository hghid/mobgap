const path = require('node:path');
const { spawn } = require('node:child_process');
const shortcutActions = new Map([
  ['--squirrel-install', '--createShortcut'],
  ['--squirrel-updated', '--createShortcut'],
  ['--squirrel-uninstall', '--removeShortcut'],
]);

/** Handle Squirrel lifecycle invocations before any application windows or runtime are initialized. */
function handleWindowsInstall(app, { platform = process.platform, argv = process.argv,
  execPath = process.execPath, spawnProcess = spawn } = {}) {
  if (platform !== 'win32') return false;
  const event = argv[1];
  if (event === '--squirrel-obsolete') { app.quit(); return true; }
  const action = shortcutActions.get(event);
  if (!action) return false;

  const updater = path.win32.resolve(path.win32.dirname(execPath), '..', 'Update.exe');
  const executable = path.win32.basename(execPath);
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    if (code === 0) app.quit();
    else app.exit(1);
  };
  try {
    const child = spawnProcess(updater, [`${action}=${executable}`], { windowsHide: true, timeout: 10_000 });
    child.once('error', () => finish(1));
    child.once('close', finish);
  } catch { finish(1); }
  return true;
}

module.exports = { handleWindowsInstall };
