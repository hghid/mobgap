import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = path.join(root, 'out', `MobGap-${process.platform}-${process.arch}`);
const executable = process.platform === 'darwin' ? path.join(bundle, 'MobGap.app/Contents/MacOS/mobgap') :
  path.join(bundle, process.platform === 'win32' ? 'mobgap.exe' : 'mobgap');
await access(executable);
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, MOBGAP_EXECUTABLE: executable },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
