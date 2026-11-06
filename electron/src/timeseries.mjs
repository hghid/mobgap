export const MAX_TRACE_POINTS = 2000;

/** Retain ordered minima/maxima in equal sample buckets, including the first and last sample. */
export function subsampleTrace(values, timestamps, midnightUs, limit = MAX_TRACE_POINTS) {
  const count = values.length;
  if (timestamps.length !== count || limit < 4 || !Number.isInteger(limit)) throw new Error('Invalid timeseries preview dimensions.');
  const point = (index) => [Number(timestamps[index] - midnightUs) / 1_000_000, values[index]];
  if (count <= limit) return Array.from({ length: count }, (_, index) => point(index));
  const points = [point(0)];
  const buckets = Math.floor((limit - 2) / 2);
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = 1 + Math.floor(bucket * (count - 2) / buckets);
    const end = 1 + Math.floor((bucket + 1) * (count - 2) / buckets);
    let minimum = start;
    let maximum = start;
    for (let index = start + 1; index < end; index++) {
      if (values[index] < values[minimum]) minimum = index;
      if (values[index] > values[maximum]) maximum = index;
    }
    points.push(point(Math.min(minimum, maximum)));
    if (minimum !== maximum) points.push(point(Math.max(minimum, maximum)));
  }
  points.push(point(count - 1));
  return points;
}

/** Condense only the decoded calendar-day input, before scientific processing modifies its representation. */
export function condenseCwaDay(decoded, day, sampleRateHz) {
  const midnightUs = BigInt(Date.parse(`${day.date}T00:00:00Z`)) * 1000n;
  const timestamps = decoded.timestamps;
  const groups = {};
  for (const [group, prefix, unit] of [['accelerometer', 'acc', 'g'], ['gyroscope', 'gyr', '°/s']]) {
    groups[group] = {
      unit,
      traces: ['x', 'y', 'z'].map((axis) => ({
        axis,
        points: subsampleTrace(decoded.channels[`${prefix}_${axis}`], timestamps, midnightUs),
      })),
    };
  }
  return {
    date: day.date, sample_count: timestamps.length, sample_rate_hz: sampleRateHz,
    point_limit: MAX_TRACE_POINTS, method: 'min-max envelope',
    start_s: Number(timestamps[0] - midnightUs) / 1_000_000,
    end_s: Number(timestamps.at(-1) - midnightUs) / 1_000_000,
    groups,
  };
}
