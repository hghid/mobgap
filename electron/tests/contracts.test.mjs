import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assetName, isTrustedURL, validateExport, websiteURL, tableCsvExport } = require('../src/contracts.cjs');

test('CSV exports retain all rows and precision, escape special characters, and use a safe filename', () => {
  const result = tableCsvExport({ name: 'strides', day: 'combined', table: {
    columns: ['day', 'value', 'note'], rows: [['2024-01-02', 1.123456789012345, 'a,"b"\r\nc'], ['2024-01-03', null, '°/s']],
  } });
  assert.equal(result.filename, 'mobgap-combined-strides.csv');
  assert.equal(result.contents, '\uFEFF"day","value","note"\r\n"2024-01-02","1.123456789012345","a,""b""\r\nc"\r\n"2024-01-03","","°/s"\r\n');
  assert.equal(tableCsvExport({ name: 'strides', day: '2024-01-02', table: { columns: ['start'], rows: [] } }).contents,
    '\uFEFF"start"\r\n');
  for (const payload of [
    { name: '../bad', day: 'combined', table: { columns: ['a'], rows: [] } },
    { name: 'strides', day: '../bad', table: { columns: ['a'], rows: [] } },
    { name: 'strides', day: 'combined', table: { columns: ['a'], rows: [[1, 2]] } },
    { name: 'strides', day: 'combined', table: { columns: ['a'], rows: [[Infinity]] } },
  ]) assert.throws(() => tableCsvExport(payload), /Invalid/);
});

test('website links resolve only to the two fixed public destinations', () => {
  assert.equal(websiteURL('inkspot'), 'https://inkspot.science/');
  assert.equal(websiteURL('mobgap'), 'https://github.com/mobilise-d/mobgap');
  for (const value of ['https://example.com', 'https://inkspot.science/?data=recording',
    'file:///etc/passwd', 'constructor', null, {}]) {
    assert.throws(() => websiteURL(value), /Unknown website/);
  }
});

test('only explicitly bundled assets are readable', () => {
  const allowed = new Set(['src/index.html', 'runtime/pyodide.asm.wasm']);
  assert.equal(assetName('mobgap://app/src/index.html', allowed), 'src/index.html');
  for (const url of ['mobgap://app/src/../main.cjs', 'mobgap://other/src/index.html',
    'mobgap://app/runtime/%2e%2e%2fpackage.json', 'mobgap://app/%zz',
    'mobgap://app/src%5c..%5cmain.cjs', 'file:///etc/passwd']) {
    assert.equal(assetName(url, allowed), null, url);
  }
  assert.equal(isTrustedURL('https://app/src/index.html'), false);
  assert.equal(isTrustedURL('mobgap://user@app/src/index.html'), false);
});

test('result export requires the versioned result contract and bounded size', () => {
  const text = JSON.stringify({ schema_version: 1, tables: {}, provenance: {} });
  assert.equal(validateExport(text), text);
  assert.throws(() => validateExport('{}'), /Invalid/);
  assert.throws(() => validateExport({}), /too large/);
  assert.throws(() => validateExport(' '.repeat(32 * 1024 * 1024 + 1)), /too large/);
});
