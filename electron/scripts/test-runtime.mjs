import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { glob, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPyodide } from 'pyodide';

process.on('uncaughtException', (error) => { console.error(error.message); process.exit(1); });
const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = path.join(root, 'runtime');
const manifest = JSON.parse(await readFile(path.join(runtime, 'manifest.json')));
for (const [filename, digest] of Object.entries(manifest.integrity)) {
  assert.equal(createHash('sha256').update(await readFile(path.join(runtime, filename))).digest('hex'), digest, filename);
}
// Prevent all network requests. The runtime must work with a fresh interpreter and local artifacts only.
globalThis.fetch = async (url) => { throw new Error(`Unexpected network request: ${url}`); };
const py = await loadPyodide({ indexURL: runtime, packageCacheDir: runtime, packageBaseUrl: runtime,
  stdout: () => {}, stderr: (message) => console.error(message) });
await py.loadPackage('mobgap');
await py.runPythonAsync(await readFile(path.join(root, 'python/adapter.py'), 'utf8'));
py.runPython('validate_runtime()');
const examples = JSON.parse(await readFile(path.join(runtime, 'example-metadata.json')));
const compare = process.argv.includes('--compare');
const paths = process.argv.slice(2).filter((value) => !value.startsWith('--'));
if (process.argv.includes('--all')) {
  for await (const file of glob('*/*/*.csv', { cwd: path.join(root, '../example_data/data_csv') })) paths.push(file);
  paths.sort();
}
if (!paths.length) paths.push('HA/001/TimeMeasure1_Test11_Trial1.csv', 'MS/001/TimeMeasure1_Test11_Trial1.csv');
for (const file of paths) {
  const bytes = await readFile(path.join(root, '../example_data/data_csv', file));
  const options = examples[createHash('sha256').update(bytes).digest('hex')];
  py.FS.writeFile('/recording.csv', bytes);
  py.globals.set('options_json', JSON.stringify(options));
  const result = JSON.parse(await py.runPythonAsync(
    'json.dumps(process_csv(open("/recording.csv", "rb").read(), json.loads(options_json)), allow_nan=False)',
  ));
  if (file.includes('Test11')) assert.ok(result.tables.strides.rows.length > 0, `Expected strides for ${file}`);
  console.log(`${file}: ${result.provenance.pipeline}, ${result.tables.walking_bouts.rows.length} bouts, ${result.tables.strides.rows.length} strides, ${result.provenance.elapsed_s.toFixed(2)}s`);
  if (compare) {
    const nativePython = process.env.MOBGAP_PYTHON || path.join(root, '..', '.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const native = JSON.parse(execFileSync(nativePython, [path.join(root, 'scripts/native_results.py'),
      path.join(root, '../example_data/data_csv', file), JSON.stringify(options)], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, MPLBACKEND: 'Agg' }, stdio: ['ignore', 'pipe', 'inherit'],
    }));
    for (const [key, actual] of Object.entries(result.tables)) {
      const expected = native.tables[key];
      assert.deepEqual(actual.columns, expected.columns, `${file}: ${key} columns`);
      assert.equal(actual.rows.length, expected.rows.length, `${file}: ${key} row count`);
      for (let row = 0; row < actual.rows.length; row++) {
        for (let col = 0; col < actual.columns.length; col++) {
          const a = actual.rows[row][col];
          const b = expected.rows[row][col];
          const column = actual.columns[col];
          // Sample indices, interval boundaries and labels must match exactly.
          const discrete = /(^|_)(id|start|end|ic)$/.test(column) || typeof a !== 'number';
          if (discrete) assert.deepEqual(a, b, `${key}.${column}[${row}]`);
          else assert.ok(typeof b === 'number' && Math.abs(a - b) <= 1e-8 + Math.abs(b) * 1e-7,
            `${file}: ${key}.${column}[${row}]: wasm ${a} vs native ${b}`);
        }
      }
    }
    console.log('  All five result tables match native CPython (rtol=1e-7, atol=1e-8; exact indices and labels).');
  }
}
