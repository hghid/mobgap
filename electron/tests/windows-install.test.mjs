import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const { handleWindowsInstall } = createRequire(import.meta.url)('../src/windows-install.cjs');

function invocation(event, platform = 'win32') {
  const child = new EventEmitter();
  const calls = [];
  const exits = [];
  const app = { quit: () => exits.push(0), exit: (code) => exits.push(code) };
  const handled = handleWindowsInstall(app, { platform, argv: ['mobgap.exe', event],
    execPath: 'C:\\Users\\A User\\AppData\\Local\\MobGap\\app-0.1.0\\mobgap.exe',
    spawnProcess: (...args) => { calls.push(args); return child; } });
  return { handled, child, calls, exits };
}

test('installer lifecycle waits for shortcut creation/removal and never launches the application', () => {
  for (const [event, action] of [['install', 'createShortcut'], ['updated', 'createShortcut'], ['uninstall', 'removeShortcut']]) {
    const run = invocation(`--squirrel-${event}`);
    assert.equal(run.handled, true);
    assert.equal(run.calls.length, 1);
    assert.deepEqual(run.calls[0], ['C:\\Users\\A User\\AppData\\Local\\MobGap\\Update.exe',
      [`--${action}=mobgap.exe`], { windowsHide: true, timeout: 10_000 }]);
    assert.deepEqual(run.exits, []);
    run.child.emit('close', 0);
    assert.deepEqual(run.exits, [0]);
  }
});

test('normal launches and first-run invocations continue; obsolete versions exit immediately', () => {
  for (const event of [undefined, '--squirrel-firstrun', '--other', 'constructor']) {
    const run = invocation(event);
    assert.equal(run.handled, false);
    assert.equal(run.calls.length, 0);
    assert.deepEqual(run.exits, []);
  }
  const obsolete = invocation('--squirrel-obsolete');
  assert.equal(obsolete.handled, true);
  assert.equal(obsolete.calls.length, 0);
  assert.deepEqual(obsolete.exits, [0]);
  assert.equal(invocation('--squirrel-install', 'darwin').handled, false);
  assert.equal(invocation('--squirrel-uninstall', 'linux').handled, false);
});

test('shortcut failures cause one unsuccessful installer exit, including spawn errors', () => {
  for (const fail of [
    (child) => child.emit('close', 1),
    (child) => { child.emit('error', new Error('updater unavailable')); child.emit('close', -1); },
  ]) {
    const run = invocation('--squirrel-install');
    fail(run.child);
    assert.deepEqual(run.exits, [1]);
  }
});
