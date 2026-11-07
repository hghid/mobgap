import init, { PacketBatchReader, readHeader, readMetadata, readMetadataFromFileSync } from '../runtime/cwa/cwa_reader_browser.js';

const READER_CHANNELS = ['acc_x', 'acc_y', 'acc_z', 'gyro_x', 'gyro_y', 'gyro_z'];
let initializing;

export async function initializeCwa(moduleBytes) {
  initializing ??= init(moduleBytes ? { module_or_path: moduleBytes } : undefined).catch((error) => {
    initializing = undefined;
    throw error;
  });
  await initializing;
}

/** Decode bounded packet batches with the upstream shared Rust parser, retaining exact microseconds. */
export async function inspectCwa(source) {
  await initializeCwa();
  return source instanceof Uint8Array ? readMetadata(source) : readMetadataFromFileSync(source);
}

export async function decodeCwa(source, sampleRateHz, progress = () => {}, cut) {
  const buffered = source instanceof Uint8Array;
  if (!buffered && !(source instanceof Blob)) throw new Error('Invalid CWA recording data.');
  const size = buffered ? source.byteLength : source.size;
  const read = async (offset, length) => buffered ? source.subarray(offset, offset + length) :
    new Uint8Array(await source.slice(offset, offset + length).arrayBuffer());
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0 || sampleRateHz > 1000) throw new Error('Select a processing rate greater than zero and at most 1000 Hz.');
  await initializeCwa();
  const header = readHeader(await read(0, 1024));
  const reader = new PacketBatchReader(size, false, {
    resample_hz: sampleRateHz, resample_method: 'cubic',
    ...(cut ? { cut } : {}),
    include_magnetometer: false, include_temperature: false, include_light: false, include_battery: false,
    batchPackets: 128, overlapPackets: 1,
  });
  const chunks = [];
  let count = 0;
  let previous;
  try {
    for (let request; (request = reader.request()) !== null;) {
      if (!Number.isSafeInteger(request.offset) || !Number.isSafeInteger(request.length) || request.offset < 0 ||
          request.length < 0 || request.offset + request.length > size) throw new Error('CWA parser requested an invalid byte range.');
      const chunk = reader.provide(await read(request.offset, request.length));
      if (!chunk || !chunk.timestamps_us.length) continue;
      const missing = READER_CHANNELS.filter((name) => !chunk.columns[name]);
      if (missing.length) throw new Error('This CWA recording is missing accelerometer or gyroscope channels. Mobilise-D and Weartime require all six IMU channels; accelerometer-only AX3 recordings are unsupported.');
      count += chunk.timestamps_us.length;
      for (const name of READER_CHANNELS) {
        const channel = chunk.columns[name];
        if (channel.length !== chunk.timestamps_us.length || !channel.every(Number.isFinite)) throw new Error(`CWA channel ${name} contains missing or invalid measurements.`);
      }
      for (const time of chunk.timestamps_us) {
        if (previous !== undefined && time <= previous) throw new Error('CWA timestamps are not strictly increasing.');
        previous = time;
      }
      chunks.push(chunk);
      progress('decode', `Decoding CWA… ${count.toLocaleString()} samples`);
      // Yield between owned batches for progress events; cancelling the worker also stops Rust execution.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally { reader.free(); }
  if (!count) throw new Error('No CWA samples in this calendar day.');
  const timestamps = new BigInt64Array(count);
  const channels = Object.fromEntries(READER_CHANNELS.map((name) => [name.replace('gyro_', 'gyr_'), new Float32Array(count)]));
  let offset = 0;
  for (const chunk of chunks) {
    timestamps.set(chunk.timestamps_us, offset);
    for (const name of READER_CHANNELS) channels[name.replace('gyro_', 'gyr_')].set(chunk.columns[name], offset);
    offset += chunk.timestamps_us.length;
  }
  return { channels, timestamps, header };
}
