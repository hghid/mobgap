import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, openAsBlob } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPyodide } from 'pyodide';
import { decodeCwa, initializeCwa } from '../src/cwa-import.mjs';

process.on('uncaughtException', (error) => { console.error(error.message); process.exit(1); });
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const privateRun = args.some((arg) => arg === '--input' || arg.startsWith('--input='));
const directory = path.join(root, '.cache/bam-tests', privateRun ? 'private' : 'synthetic');
const python = process.env.MOBGAP_PYTHON || path.join(root, '..', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
{
  const native = spawnSync(python, ['scripts/bam_native_oracle.py', ...args], {
    cwd: root, stdio: 'inherit', env: { ...process.env, MPLBACKEND: 'Agg' },
  });
  if (native.error) throw native.error;
  if (native.status !== 0) process.exit(native.status ?? 1);
}
const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json')));
const runtime = path.join(root, 'runtime');
const runtimeManifest = JSON.parse(await readFile(path.join(runtime, 'manifest.json')));
for (const [name, digest] of Object.entries(runtimeManifest.integrity)) {
  assert.equal(createHash('sha256').update(await readFile(path.join(runtime, name))).digest('hex'), digest, name);
}
await initializeCwa(await readFile(path.join(runtime, 'cwa/cwa_reader_browser_bg.wasm')));
globalThis.fetch = async () => { throw new Error('Unexpected network request during offline BAM parity check.'); };
const py = await loadPyodide({ indexURL: runtime, packageBaseUrl: runtime, packageCacheDir: runtime, stdout: () => {}, stderr: () => {} });
await py.loadPackage('mobgap');
await py.runPythonAsync(await readFile(path.join(runtime, 'adapter.py'), 'utf8'));
const verified = new Set();
const measurements = [];
for (const item of manifest.cases) {
  if (!verified.has(item.path)) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(item.path)) hash.update(chunk);
    assert.equal(hash.digest('hex'), item.input_sha256, 'Original recording fingerprint');
    verified.add(item.path);
  }
  const started = performance.now();
  console.log(`Wasm BAM: ${item.day.date}, ${item.options.cohort}, ${item.rate} Hz; decoding one day…`);
  const decoded = await decodeCwa(await openAsBlob(item.path), item.rate, () => {}, item.cut);
  assert.equal(decoded.timestamps.length, item.samples, 'Decoded sample count');
  assert.equal(createHash('sha256').update(new Uint8Array(decoded.timestamps.buffer)).digest('hex'), item.timestamps_sha256,
    'Exact native/Wasm microsecond timestamps');
  for (const [column, values] of Object.entries(decoded.channels)) {
    const buffer = await readFile(path.join(directory, `${item.name}-${column}.bin`));
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    assert.equal(buffer.byteLength, values.length * 4);
    for (let i = 0; i < values.length; i++) {
      const expected = view.getFloat32(i * 4, true);
      assert.ok(Math.abs(values[i] - expected) <= 1e-6 + Math.abs(expected) * 1e-6, `${column}: native/Wasm decoding at sample ${i}`);
    }
  }
  console.log(`  Decoded ${item.samples.toLocaleString()} samples; running configured daily pipeline…`);
  const proxies = [];
  try {
    for (const [name, value] of Object.entries({ bam_channels: decoded.channels, bam_times: decoded.timestamps,
      bam_header: decoded.header, bam_options: item.options, bam_digest: item.input_sha256 })) {
      const proxy = py.toPy(value); proxies.push(proxy); py.globals.set(name, proxy);
    }
    const actual = JSON.parse(await py.runPythonAsync(
      'json.dumps(process_cwa(None, bam_channels, bam_times, bam_header, bam_options, input_sha256=bam_digest), allow_nan=False)'));
    const expected = JSON.parse(await readFile(item.expected));
    assert.equal(actual.provenance.pipeline, expected.pipeline);
    assert.equal(actual.provenance.pipeline_type, 'bam');
    assert.equal(actual.provenance.options.measurement_condition, 'free_living');
    assert.equal(actual.provenance.duration_s / 3600, expected.day_hours);
    assert.deepEqual(Object.keys(actual.tables), Object.keys(expected.tables));
    for (const [name, table] of Object.entries(expected.tables)) {
      assert.deepEqual(actual.tables[name].columns, table.columns, `${name}: columns`);
      assert.equal(actual.tables[name].rows.length, table.rows.length, `${name}: rows`);
      for (let i = 0; i < table.rows.length; i++) for (let j = 0; j < table.columns.length; j++) {
        const a = actual.tables[name].rows[i][j]; const b = table.rows[i][j];
        const label = `${item.name} ${name}.${table.columns[j]}[${i}]`;
        if (typeof a === 'number' && !/(^|_)(id|start|end|ic)$/.test(table.columns[j])) {
          assert.ok(typeof b === 'number' && Math.abs(a - b) <= 1e-8 + Math.abs(b) * 1e-7, label);
        } else assert.deepEqual(a, b, label);
      }
    }
    await writeFile(path.join(directory, `${item.name}-wasm.json`), JSON.stringify(actual));
    measurements.push({ date: item.day.date, samples: item.samples, pipeline: actual.provenance.pipeline,
      walking_bouts: actual.tables.walking_bouts.rows.length, strides: actual.tables.strides.rows.length,
      pipeline_s: actual.provenance.elapsed_s, decode_and_pipeline_s: (performance.now() - started) / 1000,
      matched_tables: Object.keys(actual.tables), reference_file_sha256: expected.reference_file_sha256 });
    console.log(`  MATCH: all six tables, ${actual.tables.walking_bouts.rows.length} walking bouts, ${actual.tables.strides.rows.length} strides; ${((performance.now() - started) / 1000).toFixed(1)}s decode + pipeline.`);
  } finally {
    for (const name of ['bam_channels', 'bam_times', 'bam_header', 'bam_options', 'bam_digest']) py.globals.delete(name);
    for (const proxy of proxies) proxy?.destroy?.();
    py.runPython('import gc\ngc.collect()');
  }
}
const report = { node: process.version, platform: process.platform, architecture: process.arch,
  pyodide: runtimeManifest.pyodide, max_rss_kib: process.resourceUsage().maxRSS, cases: measurements };
await writeFile(path.join(directory, 'comparison-report.json'), JSON.stringify(report, null, 2));
console.log(`Peak Node/Pyodide process RSS: ${(report.max_rss_kib / 1024).toFixed(0)} MiB (includes runtime and day transfers).`);
