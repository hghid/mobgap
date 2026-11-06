import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPyodide } from 'pyodide';
import { decodeCwa, initializeCwa } from '../src/cwa-import.mjs';

process.on('uncaughtException', (error) => { console.error(error.message); process.exit(1); });
const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.MOBGAP_PYTHON || path.join(root, '..', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit', env: { ...process.env, MPLBACKEND: 'Agg' } });
  if (result.error) throw result.error;
  if (result.status) process.exit(result.status);
}
run(python, ['scripts/cwa_native_oracle.py']);
run(process.execPath, ['--test', 'tests/cwa.spec.mjs']);
const runtime = path.join(root, 'runtime');
await initializeCwa(await readFile(path.join(runtime, 'cwa/cwa_reader_browser_bg.wasm')));
globalThis.fetch = async (url) => { throw new Error(`Unexpected network request: ${url}`); };
const py = await loadPyodide({ indexURL: runtime, packageBaseUrl: runtime, packageCacheDir: runtime, stdout: () => {}, stderr: () => {} });
await py.loadPackage('mobgap');
await py.runPythonAsync(await readFile(path.join(runtime, 'adapter.py'), 'utf8'));
const native = JSON.parse(await readFile(path.join(root, '.cache/cwa-tests/native.json')));
const comparisons = [...native.cases.filter((entry) => entry.options), ...native.daily.days.map((day) => ({
  name: `day-${day.date}`, path: native.daily.path, rate: 100, options: native.daily.options,
  cut: { type: 'seconds', start: day.start_s, end: day.end_s },
}))];
for (const item of comparisons) {
  const bytes = await readFile(item.path);
  const data = await decodeCwa(bytes, item.rate, () => {}, item.cut);
  const proxies = [];
  try {
    for (const [key, value] of Object.entries({ original: new Uint8Array(bytes), channels: data.channels, timestamps: data.timestamps, header: data.header, options: item.options })) {
      const proxy = py.toPy(value); proxies.push(proxy); py.globals.set(key, proxy);
    }
    const result = JSON.parse(await py.runPythonAsync('json.dumps(process_cwa(bytes(original), channels, timestamps, header, options), allow_nan=False)'));
    const expected = JSON.parse(await readFile(path.join(root, `.cache/cwa-tests/${item.name}-results.json`)));
    for (const [key, actual] of Object.entries(result.tables)) {
      assert.deepEqual(actual.columns, expected.tables[key].columns);
      assert.equal(actual.rows.length, expected.tables[key].rows.length, `${item.name}: ${key} row count`);
      for (let i = 0; i < actual.rows.length; i++) {
        for (let j = 0; j < actual.columns.length; j++) {
          const a = actual.rows[i][j]; const b = expected.tables[key].rows[i][j];
          if (typeof a === 'number' && !/(^|_)(id|start|end|ic)$/.test(actual.columns[j])) {
            assert.ok(typeof b === 'number' && Math.abs(a - b) <= 1e-8 + Math.abs(b) * 1e-7, `${item.name}: ${key}[${i},${j}]`);
          } else assert.deepEqual(a, b);
        }
      }
    }
    assert.equal(result.provenance.input_sha256, expected.provenance.input_sha256);
    assert.equal(result.provenance.source.first_sample_device_time_us, expected.provenance.source.first_sample_device_time_us);
    console.log(`${item.name}: all five pipeline tables match native Python, ${result.tables.strides.rows.length} strides.`);
  } finally {
    for (const key of ['original', 'channels', 'timestamps', 'header', 'options']) {
      if (py.globals.has(key)) py.globals.delete(key);
    }
    for (const proxy of proxies) proxy?.destroy?.();
    py.runPython('import gc\ngc.collect()');
  }
}
