import { loadPyodide } from '../runtime/pyodide.mjs';
import { condenseCwaDay } from './timeseries.mjs';

let py;
let busy = false;
let runtimeInfo;
const post = (type, id, data = {}) => self.postMessage({ version: 1, type, id, ...data });
const runtimeURL = new URL('../runtime/', import.meta.url).href;

async function initialize() {
  post('progress', null, { stage: 'runtime', message: 'Starting the local Python runtime…' });
  py = await loadPyodide({ indexURL: runtimeURL, packageBaseUrl: runtimeURL });
  const manifestResponse = await fetch(`${runtimeURL}manifest.json`);
  if (!manifestResponse.ok) throw new Error('The runtime manifest is missing. Prepare the runtime again.');
  const manifest = await manifestResponse.json();
  runtimeInfo = { pyodide: manifest.pyodide, python: manifest.python,
    packages: manifest.packages, cwa_reader: manifest.cwa_reader, asset_hashes: manifest.integrity };
  post('progress', null, { stage: 'dependencies', message: 'Loading bundled scientific packages…' });
  await py.loadPackage('mobgap');
  const response = await fetch(`${runtimeURL}adapter.py`);
  if (!response.ok) throw new Error('The Python recording adapter is missing. Prepare the runtime again.');
  py.globals.set('adapter_source', await response.text());
  try {
    await py.runPythonAsync(`
import warnings
with warnings.catch_warnings(record=True) as runtime_warnings:
    warnings.simplefilter("always")
    exec(compile(adapter_source, "adapter.py", "exec"), globals())
validate_runtime()
RUNTIME_NOTICES = [str(item.message) for item in runtime_warnings]
`);
  } finally { py.globals.delete('adapter_source'); }
  post('ready', null);
}
const ready = initialize().catch((error) => { post('error', null, { message: error.message }); throw error; });
// The ready rejection is delivered to the renderer; consume it even if no job follows.
ready.catch(() => {});

self.onmessage = async ({ data }) => {
  if (data.version !== 1 || data.type !== 'run' || typeof data.id !== 'string') return;
  if (busy) { post('error', data.id, { message: 'A recording is already being processed.' }); return; }
  busy = true;
  const proxies = [];
  const setPython = (name, value) => {
    const proxy = py.toPy(value);
    proxies.push(proxy);
    py.globals.set(name, proxy);
  };
  try {
    await ready;
    if (!['csv', 'cwa'].includes(data.format ?? 'csv')) throw new Error('Unsupported recording format.');
    setPython('run_options', data.options);
    py.runPython('validate_options(run_options)');
    let days;
    let digest;
    let cwa;
    let metadata;
    if (data.format === 'cwa') {
      if (!(data.file instanceof Blob)) throw new Error('Choose a CWA file again.');
      post('progress', data.id, { stage: 'decode', message: 'Preparing the local CWA importer…' });
      cwa = await import('./cwa-import.mjs');
      metadata = await cwa.inspectCwa(data.file);
      if (!metadata.start_from_data_raw || !metadata.end_from_data_raw) throw new Error('CWA contains no timestamped samples.');
      setPython('recording_metadata', metadata);
      days = JSON.parse(py.runPython('json.dumps(calendar_days(recording_metadata["start_from_data_raw"], recording_metadata["end_from_data_raw"], recording_metadata["sample_rate_hz"]))'));
      const hasher = py.runPython('hashlib.sha256()');
      try {
        for (let offset = 0; offset < data.file.size; offset += 4 * 1024 * 1024) {
          const chunk = py.toPy(new Uint8Array(await data.file.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer()));
          try { hasher.update(chunk); } finally { chunk.destroy(); }
          post('progress', data.id, { stage: 'hash', message: `Reading input fingerprint… ${Math.min(offset + 4 * 1024 * 1024, data.file.size).toLocaleString()} / ${data.file.size.toLocaleString()} bytes` });
        }
        digest = hasher.hexdigest();
      } finally { hasher.destroy(); }
    } else {
      if (!(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength > 64 * 1024 * 1024) throw new Error('Invalid CSV recording size.');
      setPython('recording_input', new Uint8Array(data.bytes));
      py.runPython('csv_data = load_csv(bytes(recording_input), run_options)');
      days = JSON.parse(py.runPython('json.dumps(csv_days(csv_data, run_options))'));
      digest = py.runPython('hashlib.sha256(bytes(recording_input)).hexdigest()');
    }
    setPython('input_digest', digest);
    const sharedProxyCount = proxies.length;
    let failed = 0;
    for (let index = 0; index < days.length; index++) {
      const day = days[index];
      const started = performance.now();
      post('day-start', data.id, { day, index, total: days.length });
      const report = (stage, message) => post('progress', data.id, { stage, message: `${day.date} (${index + 1}/${days.length}) · ${message}` });
      py.globals.set('report_progress', report);
      setPython('day_window', day);
      let json;
      let preview;
      const emit = (result) => {
        result.provenance.elapsed_s = (performance.now() - started) / 1000;
        result.provenance.runtime = runtimeInfo;
        result.provenance.calendar_day = day;
        result.provenance.sample_index_basis = 'Relative to this calendar-day batch';
        post('result', data.id, { result, preview, day, index, total: days.length });
      };
      try {
        if (data.format === 'cwa') {
          const decoded = await cwa.decodeCwa(data.file, data.options.sampling_rate_hz, report,
            { type: 'seconds', start: day.start_s, end: day.end_s });
          preview = condenseCwaDay(decoded, day, data.options.sampling_rate_hz);
          if (decoded.timestamps.length < Math.ceil(5 * data.options.sampling_rate_hz)) {
            py.globals.set('day_samples', decoded.timestamps.length);
            json = py.runPython('json.dumps(short_day_result(day_samples, run_options, input_digest, "cwa"))');
          } else {
            setPython('cwa_channels', decoded.channels);
            setPython('cwa_timestamps', decoded.timestamps);
            setPython('cwa_header', decoded.header);
            json = await py.runPythonAsync('json.dumps(process_cwa(None, cwa_channels, cwa_timestamps, cwa_header, run_options, progress=report_progress, input_sha256=input_digest), allow_nan=False)');
          }
        } else {
          json = await py.runPythonAsync('json.dumps(process_csv_day(csv_data, day_window, run_options, input_digest, report_progress), allow_nan=False)');
        }
        emit(JSON.parse(json));
      } catch (error) {
        if (days.length === 1) throw error;
        failed++;
        const result = JSON.parse(py.runPython('json.dumps(short_day_result(0, run_options, input_digest, "cwa"))'));
        result.status = 'failed';
        result.warnings = [error.message];
        result.provenance.input_format = data.format;
        result.provenance.pipeline = 'Failed day';
        emit(result);
      } finally {
        for (const name of ['cwa_channels', 'cwa_timestamps', 'cwa_header', 'day_window', 'day_samples']) {
          if (py.globals.has(name)) py.globals.delete(name);
        }
        // Destroy the proxies holding this day's arrays before decoding the next day.
        while (proxies.length > sharedProxyCount) proxies.pop()?.destroy?.();
        py.runPython('import gc\ngc.collect()');
      }
    }
    post('complete', data.id, { total: days.length, failed });
  } catch (error) {
    post('error', data.id, { message: error.message });
  } finally {
    for (const proxy of proxies) proxy?.destroy?.();
    if (py) {
      for (const name of ['recording_input', 'run_options', 'recording_metadata', 'csv_data', 'input_digest', 'report_progress', 'cwa_channels', 'cwa_timestamps', 'cwa_header', 'day_window', 'day_samples']) {
        if (py.globals.has(name)) py.globals.delete(name);
      }
      py.runPython('import gc\ngc.collect()');
    }
    busy = false;
  }
};
