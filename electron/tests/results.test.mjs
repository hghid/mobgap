import assert from 'node:assert/strict';
import test from 'node:test';
import { combineDayResults } from '../src/results.mjs';

function day(date, tables, status) {
  return { schema_version: 1, ...(status ? { status } : {}), tables, warnings: status ? [status] : [],
    provenance: { calendar_day: { date }, input_sha256: 'abc', pipeline: 'Test pipeline',
      pipeline_type: 'mobilised', samples: 100, duration_s: 1, elapsed_s: 0.1 } };
}

test('combined tables put day first, retain repeated daily identifiers and full precision, without mutating days', () => {
  const days = [day('2024-01-02', { strides: { columns: ['id', 'start', 'value'], rows: [[0, 12, 1.123456789012345]] } }),
    day('2024-01-03', { strides: { columns: ['id', 'start', 'value'], rows: [[0, 3, null]] } })];
  const original = structuredClone(days);
  const result = combineDayResults(days);
  assert.deepEqual(result.tables.strides, { columns: ['day', 'id', 'start', 'value'],
    rows: [['2024-01-02', 0, 12, 1.123456789012345], ['2024-01-03', 0, 3, null]] });
  assert.deepEqual(days, original);
  assert.equal(result.provenance.samples, 200);
  assert.equal(result.provenance.duration_s, 2);
  assert.equal(result.provenance.view, 'combined');
  assert.equal(result.provenance.calendar_day, null);
  assert.equal(result.provenance.day_runs.length, 2);
});

test('failed and skipped days stay explicit; schemas are joined by column name, including empty tables', () => {
  const result = combineDayResults([
    day('2024-01-01', { wear: { columns: [], rows: [] } }, 'failed'),
    day('2024-01-02', { wear: { columns: ['start', 'end'], rows: [[0, 12]] } }),
    day('2024-01-03', { wear: { columns: ['end', 'start', 'note'], rows: [[25, 2, 'wear']] } }),
    day('2024-01-04', { wear: { columns: [], rows: [] } }, 'skipped'),
  ]);
  assert.deepEqual(result.tables.wear, { columns: ['day', 'start', 'end', 'note'],
    rows: [['2024-01-02', 0, 12, null], ['2024-01-03', 2, 25, 'wear']] });
  assert.deepEqual(result.warnings, ['2024-01-01: failed', '2024-01-04: skipped']);
  assert.deepEqual(result.provenance.day_runs.map((item) => item.status), ['failed', 'complete', 'complete', 'skipped']);
});
