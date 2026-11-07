import { renderTimeseries } from './timeseries-plot.mjs';
import { combineDayResults } from './results.mjs';

const $ = (id) => document.getElementById(id);
const names = { aggregated: 'Aggregated', walking_bouts: 'Walking bouts', strides: 'Strides',
  gait_sequences: 'Gait sequences', initial_contacts: 'Initial contacts',
  weartime_summary: 'Weartime summary', weartime: 'Wear intervals', weartime_diagnostics: 'Weartime diagnostics' };
const participantFields = ['cohort', 'height_m', 'sensor_height_m', 'measurement_condition'];
const fields = ['sampling_rate_hz', 'acceleration_unit', ...participantFields, 'recording_start_time', 'pipeline_type'];
let worker;
let ready = false;
let busy = false;
let selected;
let result;
let dayResults = [];
let dayPreviews = [];
let combinedResult;
let dayLabel = '';
let requestId;
let activeTable;
let page = 0;
let started;
let watchdog;
const PAGE_SIZE = 100;

function status(message, working = false) {
  $('status').textContent = message;
  $('progress').hidden = !working;
}

function controls() {
  $('start-cwa').disabled = busy;
  $('open-workspace').disabled = busy;
  $('show-start').disabled = busy;
  $('pipeline_type').disabled = busy;
  const weartime = $('pipeline_type').value === 'weartime';
  for (const field of participantFields) $(field).disabled = busy || weartime;
  $('sampling_rate_hz').min = weartime ? '50' : '0.01';
  $('pipeline-hint').textContent = weartime ? 'Signal-based wear detection · ≥50 Hz · no participant details required' :
    'HA / COPD / CHF → healthy · MS / PD / PFF → impaired';
  $('metadata-hint').textContent = weartime ?
    'Weartime uses the default WtdMegaritisSignal detector on all six IMU channels at ≥50 Hz. Check sampling rate and units; participant details are not required.' :
    selected?.example ? 'Metadata loaded from the matching repository example. You can review it before running.' :
    selected?.format === 'cwa' ?
      'CWA is decoded locally with cubic resampling (default 100 Hz), acceleration in g and gyroscope in °/s. Enter participant measurements and condition; mounting must match the Mobilise-D frame.' :
      'Enter recording units, sample rate and participant measurements. The app does not infer these from signal values.';
  $('choose').disabled = busy;
  $('choose-cwa').disabled = busy;
  $('run').disabled = !ready || busy || !selected;
  $('settings-fields').disabled = busy;
  $('acceleration_unit').disabled = selected?.format === 'cwa';
  $('recording_start_time').disabled = selected?.format === 'cwa';
  $('recording-start-field').hidden = selected?.format === 'cwa';
  $('cancel').hidden = !busy;
}

function showScreen(analysis) {
  $('start-screen').hidden = analysis;
  $('analysis-screen').hidden = !analysis;
  window.scrollTo(0, 0);
  $(analysis ? 'input-heading' : 'welcome-heading').focus();
}

function stopTimer() { clearTimeout(watchdog); started = null; }

function fail(message) {
  busy = false;
  stopTimer();
  $('error').hidden = false;
  const lines = String(message).trim().split('\n');
  $('error-message').textContent = lines.at(-1) || 'Processing failed.';
  $('error-details').textContent = message;
  $('stage-note').textContent = 'Check the recording and settings, or restart the runtime to try again.';
  status('Could not complete processing.');
  controls();
}

function initialize() {
  worker?.terminate();
  ready = false;
  busy = false;
  requestId = null;
  stopTimer();
  $('error').hidden = true;
  $('elapsed').textContent = '';
  $('stage-note').textContent = 'Preparing the bundled Python environment. No downloads are needed.';
  status('Starting local runtime…', true);
  controls();
  worker = new Worker(new URL('worker.mjs', import.meta.url), { type: 'module' });
  watchdog = setTimeout(() => { worker.terminate(); fail('Runtime initialization timed out. Restart the runtime to try again.'); }, 180_000);
  worker.onerror = (event) => { event.preventDefault(); ready = false; fail(event.message || 'The processing worker stopped unexpectedly.'); };
  worker.onmessageerror = () => { ready = false; fail('The processing worker returned an unreadable message.'); };
  worker.onmessage = ({ data }) => {
    if (data.version !== 1 || (data.id !== null && data.id !== requestId)) return;
    if (data.type === 'ready') {
      ready = true;
      stopTimer();
      status('Ready to process a recording.');
      $('stage-note').textContent = 'Choose a CSV or CWA and check its metadata, then run the pipeline.';
      controls();
    } else if (data.type === 'progress') {
      status(data.message, true);
      $('stage-note').textContent = data.stage === 'process' ?
        $('pipeline_type').value === 'weartime' ? 'Detecting wear intervals from accelerometer and gyroscope signals. Progress is indeterminate.' :
        'Computing gait sequences, contacts, strides and walking bouts. Duration depends on recording length; the progress bar is indeterminate.' :
        'Progress shows completed stages, rather than an estimated percentage.';
    } else if (data.type === 'day-start') {
      dayLabel = `${data.day.date} (${data.index + 1}/${data.total})`;
      status(`Processing ${dayLabel}…`, true);
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        worker.terminate(); ready = false;
        fail(`Processing ${dayLabel} exceeded the 10 minute per-day limit. Restart the runtime to try again.`);
      }, 600_000);
    } else if (data.type === 'error') {
      if (data.id === null) ready = false;
      fail(data.message);
    } else if (data.type === 'result') {
      result = data.result;
      result.provenance.input_name = selected.name;
      dayResults.push(result);
      dayPreviews.push(data.preview ?? null);
      const option = document.createElement('option');
      option.value = String(dayResults.length - 1);
      option.textContent = `${data.day.date}${result.status === 'skipped' ? ' (too short)' : result.status === 'failed' ? ' (failed)' : ''}`;
      $('day-select').append(option);
      $('day-select').value = option.value;
      renderResults();
    } else if (data.type === 'complete') {
      busy = false;
      stopTimer();
      combinedResult = combineDayResults(dayResults);
      const option = document.createElement('option');
      option.value = 'combined'; option.textContent = 'Combined'; $('day-select').append(option);
      status('Processing complete.');
      describeSelection();
      controls();
    }
  };
}

function describeSelection() {
  if (!result || busy) return;
  const failed = dayResults.filter((day) => day.status === 'failed').length;
  const scope = result.provenance.view === 'combined' ? 'across combined days' : `in ${result.provenance.calendar_day.date}`;
  $('stage-note').textContent = `${dayResults.length} calendar day${dayResults.length === 1 ? '' : 's'} finished${failed ? ` · ${failed} failed` : ''} · ${result.provenance.pipeline} · ${result.provenance.samples.toLocaleString()} samples ${scope}`;
}

function renderResults() {
  $('results').hidden = false;
  const combined = result.provenance.view === 'combined';
  const count = result.provenance.pipeline_type === 'weartime' ? `${result.tables.weartime.rows.length} wear intervals` :
    `${result.tables.walking_bouts.rows.length} walking bouts · ${result.tables.strides.rows.length} strides`;
  $('result-summary').textContent = `${combined ? `${result.provenance.day_runs.length} days combined · ` : ''}${count} · ${result.provenance.duration_s.toFixed(1)} s recording`;
  $('table-note').textContent = combined ? 'Rows are joined by day, with original day-relative indices. Daily statistics are not recalculated. Failed or skipped days remain listed in processing notices and JSON metadata.' :
    '— means unavailable or not applicable. Intervals use day-relative sample indices; end is exclusive.';
  $('tabs').replaceChildren();
  const views = Object.fromEntries(Object.keys(result.tables).map((key) => [key, names[key] ?? key]));
  if (!combined && result.provenance.input_format === 'cwa') views.timeseries = 'Timeseries';
  for (const [key, label] of Object.entries(views)) {
    const button = document.createElement('button');
    button.id = `tab-${key}`;
    button.textContent = key === 'timeseries' ? label : `${label} (${result.tables[key].rows.length})`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', key === 'timeseries' ? 'timeseries-panel' : 'table-panel');
    button.addEventListener('click', () => { activeTable = key; page = 0; renderTable(); });
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const keys = Object.keys(views);
      const current = keys.indexOf(key);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 :
        (current + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
      $(`tab-${keys[index]}`).click();
      $(`tab-${keys[index]}`).focus();
    });
    $('tabs').append(button);
  }
  if (!Object.hasOwn(views, activeTable)) activeTable = result.tables.weartime_summary ? 'weartime_summary' :
    result.tables.aggregated.rows.length ? 'aggregated' : 'gait_sequences';
  page = 0;
  renderTable();
  $('warnings').hidden = !result.warnings.length;
  $('warning-summary').textContent = `${result.warnings.length} processing notices`;
  $('warning-list').replaceChildren(...result.warnings.map((message) => {
    const item = document.createElement('li'); item.textContent = message; return item;
  }));
  describeSelection();
}

function renderTable() {
  for (const tab of $('tabs').children) {
    tab.setAttribute('aria-selected', String(tab.id === `tab-${activeTable}`));
    tab.tabIndex = tab.id === `tab-${activeTable}` ? 0 : -1;
  }
  const plotting = activeTable === 'timeseries';
  $('save-csv').disabled = plotting || !result.tables[activeTable]?.columns.length;
  $('timeseries-panel').hidden = !plotting;
  $('pagination').hidden = plotting;
  $('table-note').hidden = plotting;
  if (plotting) {
    $('table-panel').hidden = true;
    $('empty').hidden = true;
    const preview = dayPreviews[Number($('day-select').value)];
    $('plot-group').disabled = !preview;
    renderTimeseries($('timeseries-plot'), $('plot-caption'), $('plot-empty'), preview, $('plot-group').value);
    return;
  }
  const table = result.tables[activeTable];
  $('table-panel').setAttribute('aria-labelledby', `tab-${activeTable}`);
  const head = document.createElement('tr');
  for (const column of table.columns) {
    const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = column; head.append(cell);
  }
  $('result-table').tHead.replaceChildren(head);
  $('result-table').tBodies[0].replaceChildren(...table.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((row) => {
    const tr = document.createElement('tr');
    for (const value of row) {
      const td = document.createElement('td');
      const fullValue = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
      td.textContent = value === null ? '—' : typeof value === 'number' ?
        new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value) : fullValue;
      td.title = value === null ? 'Unavailable or not applicable' : fullValue;
      tr.append(td);
    }
    return tr;
  }));
  $('empty').hidden = table.rows.length > 0;
  $('empty').textContent = 'No rows for this result. Check processing notices for failed or skipped days.';
  $('table-panel').hidden = !table.rows.length;
  $('row-count').textContent = table.rows.length ?
    `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, table.rows.length)} of ${table.rows.length.toLocaleString()} rows` : '0 rows';
  $('previous').disabled = page === 0;
  $('next').disabled = (page + 1) * PAGE_SIZE >= table.rows.length;
}

async function chooseRecording(format) {
  if (format === 'cwa') { $('cwa-file').click(); return; }
  $('choose').disabled = true;
  $('choose-cwa').disabled = true;
  try {
    const chosen = await window.mobgap.chooseCsv();
    if (!chosen) return;
    useRecording({ ...chosen, bytes: new Uint8Array(chosen.bytes) });
  } catch (error) { fail(error.message); }
  finally { controls(); }
}

function useRecording(chosen) {
    const format = chosen.format;
    selected = chosen;
    result = null;
    dayResults = [];
    dayPreviews = [];
    combinedResult = undefined;
    activeTable = undefined;
    $('plot-group').value = 'accelerometer';
    $('day-select').replaceChildren();
    $('results').hidden = true;
    $('error').hidden = true;
    $('filename').textContent = chosen.name;
    $('example-label').textContent = chosen.example ? `Example: ${chosen.example.label}` : 'Custom recording';
    for (const name of fields.filter((field) => field !== 'pipeline_type')) $(name).value = chosen.example?.[name] ?? '';
    $('sampling-rate-label').textContent = format === 'cwa' ? 'Resample CWA to (Hz)' : 'Sampling rate (Hz)';
    if (format === 'cwa') {
      $('sampling_rate_hz').value = '100';
      $('acceleration_unit').value = 'g';
    }
    if (ready) status('Recording selected. Check the metadata and run the pipeline.');
    controls();
}
$('start-cwa').addEventListener('click', () => {
  if (busy) return;
  showScreen(true);
  // Keep the file-input click in this user gesture, even while Python is still starting.
  chooseRecording('cwa');
});
$('open-workspace').addEventListener('click', () => showScreen(true));
$('show-start').addEventListener('click', () => showScreen(false));
for (const link of document.querySelectorAll('[data-website]')) {
  link.addEventListener('click', async (event) => {
    event.preventDefault();
    $('website-error').hidden = true;
    try { await window.mobgap.openWebsite(link.dataset.website); }
    catch {
      $('website-error').textContent = `Could not open your browser. Visit ${link.href} in your browser.`;
      $('website-error').hidden = false;
    }
  });
}
$('choose').addEventListener('click', () => chooseRecording('csv'));
$('choose-cwa').addEventListener('click', () => chooseRecording('cwa'));
$('cwa-file').addEventListener('change', () => {
  const file = $('cwa-file').files[0];
  if (file) useRecording({ name: file.name, file, format: 'cwa', example: null });
  $('cwa-file').value = '';
});
$('day-select').addEventListener('change', () => {
  result = $('day-select').value === 'combined' ? combinedResult : dayResults[Number($('day-select').value)];
  renderResults();
});
$('pipeline_type').addEventListener('change', controls);
$('plot-group').addEventListener('change', renderTable);

$('settings').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!ready || busy || !selected || !$('settings').reportValidity()) return;
  const options = Object.fromEntries(fields.map((name) => [name, $(name).type === 'number' ? Number($(name).value) : $(name).value]));
  if (options.pipeline_type === 'mobilised' && options.sensor_height_m > options.height_m) { fail('Sensor height cannot exceed participant height.'); return; }
  if (options.pipeline_type === 'weartime') for (const field of participantFields) delete options[field];
  result = null;
  dayResults = [];
  dayPreviews = [];
  combinedResult = undefined;
  activeTable = undefined;
  $('day-select').replaceChildren();
  $('results').hidden = true;
  $('error').hidden = true;
  busy = true;
  controls();
  started = performance.now();
  requestId = crypto.randomUUID();
  status('Sending recording to the processing worker…', true);
  // Retain the selected file for repeat runs; transfer just one fresh job buffer.
  if (selected.format === 'cwa') {
    worker.postMessage({ version: 1, type: 'run', id: requestId, format: 'cwa', options, file: selected.file });
  } else {
    const bytes = selected.bytes.slice().buffer;
    worker.postMessage({ version: 1, type: 'run', id: requestId, format: 'csv', options, bytes }, [bytes]);
  }
  watchdog = setTimeout(() => {
    worker.terminate(); ready = false;
    fail('Preparing the recording exceeded the 10 minute limit. Restart the runtime to try again.');
  }, 600_000);
});
$('cancel').addEventListener('click', () => {
  initialize();
  $('stage-note').textContent = 'Run cancelled. Restarting Python; the selected recording is available for another run.';
});
$('retry').addEventListener('click', initialize);
$('previous').addEventListener('click', () => { if (page > 0) { page--; renderTable(); } });
$('next').addEventListener('click', () => { if ((page + 1) * PAGE_SIZE < result.tables[activeTable].rows.length) { page++; renderTable(); } });
$('save').addEventListener('click', async () => {
  $('save').disabled = true;
  try {
    if (await window.mobgap.saveResults(JSON.stringify(result, null, 2))) status('Results saved.');
  } catch (error) { fail(error.message); }
  finally { $('save').disabled = false; }
});
$('save-csv').addEventListener('click', async () => {
  const table = result?.tables[activeTable];
  if (!table?.columns.length) return;
  $('save-csv').disabled = true;
  try {
    if (await window.mobgap.saveTableCsv({ table, name: activeTable,
      day: result.provenance.view === 'combined' ? 'combined' : result.provenance.calendar_day.date })) status('CSV table saved.');
  } catch (error) { fail(error.message); }
  finally { $('save-csv').disabled = activeTable === 'timeseries' || !result?.tables[activeTable]?.columns.length; }
});
setInterval(() => { if (started !== null && started !== undefined) $('elapsed').textContent = `${Math.floor((performance.now() - started) / 1000)} s elapsed`; }, 1000);
initialize();
