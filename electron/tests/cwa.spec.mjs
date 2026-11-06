import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { initializeCwa, decodeCwa } from '../src/cwa-import.mjs';
import { readCwaFile, readHeader } from '../runtime/cwa/cwa_reader_browser.js';

await initializeCwa(await readFile(new URL('../runtime/cwa/cwa_reader_browser_bg.wasm', import.meta.url)));
const root = new URL('../.cache/cwa-tests/', import.meta.url);
const native = JSON.parse(await readFile(new URL('native.json', root)));

test('Rust/Wasm matches native timestamps and channels, including complete recordings above 500,000 samples', async () => {
  assert.ok(native.cases.some((item) => item.samples > 500_000), 'The parity suite must include a recording beyond the former sample cap.');
  for (const item of native.cases) {
    const bytes = await readFile(item.path);
    const decoded = readCwaFile(bytes, { resample_hz: item.rate, resample_method: 'cubic',
      include_temperature: false, include_light: false, include_battery: false, include_magnetometer: false });
    assert.equal(decoded.timestamps_us.length, item.samples, item.name);
    assert.equal(createHash('sha256').update(new Uint8Array(decoded.timestamps_us.buffer)).digest('hex'), item.timestamps_sha256, item.name);
    assert.deepEqual(Object.keys(decoded.columns).map((name) => name.replace('gyro_', 'gyr_')), item.columns);
    for (const [name, actual] of Object.entries(decoded.columns)) {
      const column = name.replace('gyro_', 'gyr_');
      const buffer = await readFile(new URL(`${item.name}-${column}.bin`, root));
      const expected = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      for (let i = 0; i < actual.length; i++) {
        const value = expected.getFloat32(i * 4, true);
        assert.ok(Math.abs(actual[i] - value) <= 1e-6 + Math.abs(value) * 1e-6, `${item.name}.${column}[${i}]`);
      }
    }
    if (item.options) {
      const batched = await decodeCwa(bytes, item.rate);
      assert.deepEqual(batched.timestamps, decoded.timestamps_us, item.name);
      for (const name of item.columns) assert.deepEqual(batched.channels[name], decoded.columns[name.replace('gyr_', 'gyro_')]);
    }
  }
});

test('malformed and accelerometer-only CWA inputs fail without disabling later imports', async () => {
  const ax3 = native.cases.find((item) => !item.options);
  await assert.rejects(decodeCwa(await readFile(ax3.path), 100), /gyroscope/);
  await assert.rejects(decodeCwa(new Uint8Array(1536), 100), /metadata/);
  await assert.rejects(decodeCwa(new Uint8Array(100), 100));
  const valid = native.cases.find((item) => item.options);
  const bytes = await readFile(valid.path);
  await assert.rejects(decodeCwa(bytes.subarray(0, 1100), 100));
  await assert.rejects(decodeCwa(bytes, -1), /processing rate/);
  assert.equal(readHeader(bytes.subarray(0, 1024)).hardware_type, 'AX6');
  assert.ok((await decodeCwa(bytes, 100)).timestamps.length > 0);
});

test('midnight CWA cuts match independent native reads with shorter first and last days', async () => {
  const bytes = await readFile(native.daily.path);
  let count = 0;
  for (const day of native.daily.days) {
    const actual = await decodeCwa(bytes, 100, () => {}, { type: 'seconds', start: day.start_s, end: day.end_s });
    assert.equal(actual.timestamps.length, day.samples);
    assert.equal(createHash('sha256').update(new Uint8Array(actual.timestamps.buffer)).digest('hex'), day.timestamps_sha256);
    count += actual.timestamps.length;
  }
  assert.equal(count, (await decodeCwa(bytes, 100)).timestamps.length);
});
