import assert from 'node:assert/strict';
import test from 'node:test';
import { condenseCwaDay, MAX_TRACE_POINTS, subsampleTrace } from '../src/timeseries.mjs';
import { clockLabel } from '../src/timeseries-plot.mjs';

test('condensed traces retain endpoints, extrema and time order within the point budget', () => {
  const count = 50_000;
  const midnight = 1704240000000000n;
  const timestamps = BigInt64Array.from({ length: count }, (_, index) => midnight + BigInt(index) * 10000n);
  const values = Float32Array.from({ length: count }, (_, index) => Math.sin(index / 100));
  values[123] = 100;
  values[4567] = -80;
  const points = subsampleTrace(values, timestamps, midnight);
  assert.ok(points.length <= MAX_TRACE_POINTS);
  assert.deepEqual(points[0], [0, values[0]]);
  assert.deepEqual(points.at(-1), [499.99, values.at(-1)]);
  assert.ok(points.some(([time, value]) => time === 1.23 && value === 100));
  assert.ok(points.some(([time, value]) => time === 45.67 && value === -80));
  for (let index = 1; index < points.length; index++) assert.ok(points[index][0] > points[index - 1][0]);
  assert.equal(values[123], 100);
});

test('day previews keep six distinct axes, device-clock offsets and decoded units', () => {
  const midnight = 1704240000000000n; // 2024-01-03, used only as naive device-clock arithmetic.
  const channels = Object.fromEntries(['acc_x', 'acc_y', 'acc_z', 'gyr_x', 'gyr_y', 'gyr_z']
    .map((channel, index) => [channel, Float32Array.of(index, index + 1, index + 2)]));
  for (const [date, offset] of [['2024-01-02', 86399], ['2024-01-03', 0]]) {
    const start = date === '2024-01-02' ? midnight - 1_000_000n : midnight;
    const timestamps = BigInt64Array.of(start, start + 10_000n, start + 20_000n);
    const preview = condenseCwaDay({ channels, timestamps }, { date }, 100);
    assert.equal(preview.date, date);
    assert.equal(preview.start_s, offset);
    assert.equal(preview.end_s, offset + 0.02);
    assert.equal(preview.sample_count, 3);
    assert.equal(preview.sample_rate_hz, 100);
    assert.equal(preview.groups.accelerometer.unit, 'g');
    assert.equal(preview.groups.gyroscope.unit, '°/s');
    assert.deepEqual(preview.groups.accelerometer.traces.map((trace) => trace.axis), ['x', 'y', 'z']);
    assert.deepEqual(preview.groups.accelerometer.traces[0].points, [[offset, 0], [offset + 0.01, 1], [offset + 0.02, 2]]);
    assert.deepEqual(preview.groups.gyroscope.traces[2].points, [[offset, 5], [offset + 0.01, 6], [offset + 0.02, 7]]);
  }
});

test('constant signals and odd point budgets remain bounded and clock labels avoid host timezone conversion', () => {
  const timestamps = BigInt64Array.from({ length: 200 }, (_, index) => BigInt(index) * 10000n);
  const points = subsampleTrace(new Float32Array(200).fill(1), timestamps, 0n, 5);
  assert.ok(points.length <= 5);
  assert.deepEqual(points[0], [0, 1]);
  assert.deepEqual(points.at(-1), [1.99, 1]);
  assert.equal(clockLabel(0), '00:00:00');
  assert.equal(clockLabel(86399.99), '23:59:59');
});
