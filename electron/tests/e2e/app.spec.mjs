import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = fileURLToPath(new URL('../../', import.meta.url));
const example = (name) => path.join(root, '../example_data/data_csv', name);

async function choose(app, page, filename, format = 'csv') {
  if (format === 'cwa') {
    const picker = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose CWA…' }).click();
    await (await picker).setFiles(filename);
  } else {
    await app.evaluate(({ dialog }, value) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [value] });
    }, filename);
    await page.getByRole('button', { name: 'Choose CSV…' }).click();
  }
  await expect(page.locator('#filename')).toHaveText(path.basename(filename));
  if (format === 'csv') await page.locator('#recording_start_time').fill('2024-01-02T00:00');
}

async function participant(page, cohort = 'HA') {
  await page.locator('#cohort').selectOption(cohort);
  await page.locator('#height_m').fill(cohort === 'MS' ? '1.68' : '1.59');
  await page.locator('#sensor_height_m').fill(cohort === 'MS' ? '0.975' : '0.964');
  await page.locator('#measurement_condition').selectOption('laboratory');
}

test.beforeAll(() => {
  const python = process.env.MOBGAP_PYTHON || path.join(root, '..', '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  execFileSync(python, ['scripts/cwa_native_oracle.py'], { cwd: root, env: { ...process.env, MPLBACKEND: 'Agg' }, stdio: 'pipe' });
});

test('offline Electron import, both pipelines, tables, export, cancellation and recovery', async ({}, testInfo) => {
  const app = await electron.launch({
    executablePath: process.env.MOBGAP_EXECUTABLE || electronPath,
    args: process.env.MOBGAP_EXECUTABLE ? [] : ['.'], cwd: root,
    env: { ...process.env, ELECTRON_ENABLE_SECURITY_WARNINGS: '1' },
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') console.error('Renderer:', message.text()); });
    await expect(page.locator('#start-screen')).toBeVisible();
    await expect(page.locator('#analysis-screen')).toBeHidden();
    await expect(page.locator('#start-screen')).toContainText('Observational Study Manager');
    await expect(page.locator('#start-screen')).toContainText('Apache License 2.0');
    const logo = page.getByRole('img', { name: 'Inkspot Science', exact: true });
    await expect.poll(() => logo.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
    const logoBox = await logo.boundingBox();
    expect(Math.abs(logoBox.x + logoBox.width / 2 - await page.evaluate(() => innerWidth / 2))).toBeLessThan(1);
    await page.screenshot({ path: testInfo.outputPath('inkspot-start.png'), fullPage: true });
    await page.setViewportSize({ width: 760, height: 600 });
    await page.screenshot({ path: testInfo.outputPath('inkspot-start-small.png'), fullPage: true });
    await page.setViewportSize({ width: 1150, height: 820 });

    // Public links use the trusted main-process bridge; the app itself stays local.
    await app.evaluate(({ shell }) => {
      globalThis.openedWebsites = [];
      shell.openExternal = async (url) => { globalThis.openedWebsites.push(url); };
    });
    const startURL = page.url();
    await page.getByRole('link', { name: /inkspot.science/ }).click();
    await page.getByRole('link', { name: /MobGap on GitHub/ }).click();
    await expect.poll(() => app.evaluate(() => globalThis.openedWebsites)).toEqual([
      'https://inkspot.science/', 'https://github.com/mobilise-d/mobgap',
    ]);
    expect(page.url()).toBe(startURL);
    await expect(page.locator('#start-screen')).toBeVisible();
    await app.evaluate(({ shell }) => { shell.openExternal = async () => { throw new Error('Browser unavailable'); }; });
    await page.getByRole('link', { name: /inkspot.science/ }).click();
    await expect(page.locator('#website-error')).toContainText('Could not open your browser');
    await app.evaluate(({ shell }) => { shell.openExternal = async () => {}; });
    await page.getByRole('link', { name: /inkspot.science/ }).click();
    await expect(page.locator('#website-error')).toBeHidden();

    // The start action opens the CWA picker without waiting for runtime readiness; cancellation leaves a usable workspace.
    const canceledPicker = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Analyse .CWA File', exact: true }).click();
    await (await canceledPicker).setFiles([]);
    await expect(page.locator('#analysis-screen')).toBeVisible();
    await expect(page.locator('#start-screen')).toBeHidden();
    await expect(page.locator('#filename')).toHaveText('No recording selected');
    await expect(page.locator('#status')).toHaveText('Ready to process a recording.', { timeout: 120_000 });
    expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
    expect(await app.evaluate(({ BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { node: prefs.nodeIntegration, sandbox: prefs.sandbox, isolation: prefs.contextIsolation };
    })).toEqual({ node: false, sandbox: true, isolation: true });
    // Main-process request filtering blocks all remote traffic even when Chromium is online.
    expect(await page.evaluate(async () => {
      try { await fetch('https://example.com'); return true; } catch { return false; }
    })).toBe(false);

    await page.getByRole('button', { name: 'Back to start', exact: true }).click();
    const cwaPicker = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Analyse .CWA File', exact: true }).click();
    expect((await cwaPicker).isMultiple()).toBe(false);
    await (await cwaPicker).setFiles(path.join(root, '.cache/cwa-tests/HA-six-axis.cwa'));
    await expect(page.locator('#filename')).toHaveText('HA-six-axis.cwa');
    await expect(page.locator('#sampling_rate_hz')).toHaveValue('100');
    await expect(page.locator('#results')).toBeHidden();
    await expect(page.locator('#cohort')).toHaveValue('');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('#cohort')).toBeFocused();
    await expect(page.locator('#results')).toBeHidden();
    await participant(page);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('#status')).toHaveText('Processing complete.', { timeout: 60_000 });
    await page.getByRole('tab', { name: 'Strides (47)', exact: true }).click();
    await expect(page.locator('#result-table tbody tr')).toHaveCount(47);
    await page.getByRole('button', { name: 'Back to start', exact: true }).click();
    await page.getByRole('button', { name: 'Open analysis workspace', exact: true }).click();
    await expect(page.locator('#filename')).toHaveText('HA-six-axis.cwa');
    await expect(page.locator('#result-table tbody tr')).toHaveCount(47);

    for (const [file, pipeline, strides] of [
      ['HA/001/TimeMeasure1_Test11_Trial1.csv', 'MobilisedPipelineHealthy', 47],
      ['MS/001/TimeMeasure1_Test11_Trial1.csv', 'MobilisedPipelineImpaired', 84],
    ]) {
      await choose(app, page, example(file));
      await expect(page.locator('#sampling_rate_hz')).toHaveValue('100');
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await expect(page.locator('#status')).toHaveText('Processing complete.', { timeout: 60_000 });
      await expect(page.locator('#stage-note')).toContainText(pipeline);
      await expect(page.getByRole('tab', { name: 'Timeseries', exact: true })).toHaveCount(0);
      await page.getByRole('tab', { name: `Strides (${strides})`, exact: true }).click();
      await expect(page.locator('#result-table tbody tr')).toHaveCount(strides);
    }

    const output = testInfo.outputPath('results.json');
    await app.evaluate(({ dialog }, filename) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename });
    }, output);
    await page.getByRole('button', { name: 'Save results…' }).click();
    await expect(page.locator('#status')).toHaveText('Results saved.');
    const saved = JSON.parse(await readFile(output));
    expect(saved.provenance.pipeline).toBe('MobilisedPipelineImpaired');
    expect(saved.tables.strides.rows).toHaveLength(84);
    expect(saved.provenance.input_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.provenance.runtime.pyodide).toBe('314.0.7');
    expect(saved.provenance.runtime.asset_hashes['pyodide.asm.wasm']).toMatch(/^[0-9a-f]{64}$/);

    // Both CWA pipelines run from the bundled Rust/Wasm module in the same sandboxed worker.
    for (const [cohort, count] of [['HA', 47], ['MS', 84]]) {
      await choose(app, page, path.join(root, `.cache/cwa-tests/${cohort}-six-axis.cwa`), 'cwa');
      await expect(page.locator('#height_m')).toHaveValue('');
      await expect(page.locator('#sampling-rate-label')).toHaveText('Resample CWA to (Hz)');
      await expect(page.locator('#sampling_rate_hz')).toHaveValue('100');
      await expect(page.locator('#acceleration_unit')).toBeDisabled();
      await participant(page, cohort);
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await expect(page.locator('#status')).toHaveText('Processing complete.', { timeout: 60_000 });
      await page.getByRole('tab', { name: `Strides (${count})`, exact: true }).click();
      await expect(page.locator('#result-table tbody tr')).toHaveCount(count);
    }
    await page.getByRole('button', { name: 'Save results…' }).click();
    await expect(page.locator('#status')).toHaveText('Results saved.');
    const cwaSaved = JSON.parse(await readFile(output));
    expect(cwaSaved).not.toHaveProperty('preview');
    expect(cwaSaved.provenance.input_format).toBe('cwa');
    expect(cwaSaved.provenance.source.resample_method).toBe('cubic');
    expect(cwaSaved.provenance.source.first_sample_device_time_us).toMatch(/^\d+$/);
    expect(cwaSaved.provenance.runtime.cwa_reader.version).toBe('0.5.0');
    expect(cwaSaved.provenance.runtime.asset_hashes['cwa/cwa_reader_browser_bg.wasm']).toMatch(/^[0-9a-f]{64}$/);
    await page.screenshot({ path: testInfo.outputPath('cwa-import.png'), fullPage: true });

    // A host-backed File larger than the old cap is selected without reading it into IPC buffers.
    const largeCwa = testInfo.outputPath('large recording.CWA');
    const largeFile = await open(largeCwa, 'w');
    try {
      await largeFile.writeFile(await readFile(path.join(root, '.cache/cwa-tests/HA-six-axis.cwa')));
      await largeFile.truncate(65 * 1024 * 1024);
    } finally { await largeFile.close(); }
    await choose(app, page, largeCwa, 'cwa');
    await expect(page.locator('#height_m')).toHaveValue('');

    // Process the complete resampled recording beyond the former 500,000-sample cap.
    const nativeCases = JSON.parse(await readFile(path.join(root, '.cache/cwa-tests/native.json')));
    const longCase = nativeCases.cases.find((item) => item.samples > 500_000);
    expect(longCase).toBeTruthy();
    await choose(app, page, longCase.path, 'cwa');
    await participant(page);
    await page.locator('#sampling_rate_hz').fill(String(longCase.rate));
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('#status')).toHaveText('Processing complete.', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Save results…' }).click();
    await expect(page.locator('#status')).toHaveText('Results saved.');
    const longSaved = JSON.parse(await readFile(output));
    expect(longSaved.provenance.samples).toBe(longCase.samples);
    const nativeLong = JSON.parse(await readFile(path.join(root, `.cache/cwa-tests/${longCase.name}-results.json`)));
    expect(longSaved.provenance.source.last_sample_device_time_us).toBe(nativeLong.provenance.source.last_sample_device_time_us);
    const longContacts = longSaved.tables.initial_contacts.rows.length;
    expect(longContacts).toBeGreaterThan(100);
    await page.getByRole('tab', { name: `Initial contacts (${longContacts})`, exact: true }).click();
    await expect(page.locator('#result-table tbody tr')).toHaveCount(100);
    const longCsvOutput = testInfo.outputPath('all-contact-pages.csv');
    await app.evaluate(({ dialog }, filename) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename });
    }, longCsvOutput);
    await page.getByRole('button', { name: 'Export table CSV…', exact: true }).click();
    await expect(page.locator('#status')).toHaveText('CSV table saved.');
    expect((await readFile(longCsvOutput, 'utf8')).split('\r\n').filter(Boolean)).toHaveLength(longContacts + 1);
    await app.evaluate(({ dialog }, filename) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename });
    }, output);

    // Each midnight-aligned partial day has its own native-equivalent tables and export.
    await choose(app, page, nativeCases.daily.path, 'cwa');
    await participant(page);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('#status')).toHaveText('Processing complete.', { timeout: 60_000 });
    await expect(page.locator('#day-select option')).toHaveCount(3);
    const [selectorBox, saveBox] = await page.evaluate(() => ['day-select', 'save']
      .map((id) => document.getElementById(id).getBoundingClientRect().toJSON()));
    await page.screenshot({ path: testInfo.outputPath('results-toolbar.png'), fullPage: true });
    expect(Math.abs(selectorBox.y - saveBox.y), JSON.stringify({ selectorBox, saveBox })).toBeLessThan(2);
    expect(saveBox.x).toBeGreaterThan(selectorBox.x + selectorBox.width);
    await page.getByRole('tab', { name: 'Timeseries', exact: true }).click();
    await expect(page.locator('#save-csv')).toBeDisabled();
    await expect(page.locator('#plot-group')).toHaveValue('accelerometer');
    await expect(page.locator('#timeseries-plot')).toHaveAttribute('aria-label', /Accelerometer \(g\)/);
    await page.locator('#plot-group').selectOption('gyroscope');
    const dayPaths = [];
    for (const [index, day] of nativeCases.daily.days.entries()) {
      await page.locator('#day-select').selectOption(String(index));
      await expect(page.getByRole('tab', { name: 'Timeseries', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#timeseries-plot')).toHaveAttribute('aria-label', `Gyroscope (°/s) — ${day.date}`);
      await expect(page.locator('#timeseries-plot polyline')).toHaveCount(3);
      await expect(page.locator('#table-panel')).toBeHidden();
      await expect(page.locator('#pagination')).toBeHidden();
      await expect(page.locator('#plot-caption')).toContainText(index === 0 ? '23:59:30–23:59:59' : '00:00:00–00:01:47');
      await expect(page.locator('#plot-caption')).toContainText(`${day.samples.toLocaleString()} decoded samples at 100 Hz`);
      const paths = await page.locator('#timeseries-plot polyline').evaluateAll((lines) => lines.map((line) => line.getAttribute('points')));
      for (const points of paths) {
        expect(points.split(' ').length).toBeLessThanOrEqual(2000);
        expect(points).not.toMatch(/NaN|Infinity/);
      }
      dayPaths.push(paths);
      await page.getByRole('button', { name: 'Save results…' }).click();
      await expect(page.locator('#status')).toHaveText('Results saved.');
      const exported = JSON.parse(await readFile(output));
      const expectedDay = JSON.parse(await readFile(path.join(root, `.cache/cwa-tests/day-${day.date}-results.json`)));
      expect(exported.provenance.calendar_day.date).toBe(day.date);
      expect(exported.provenance.samples).toBe(day.samples);
      expect(exported.tables.strides.rows).toHaveLength(expectedDay.tables.strides.rows.length);
      expect(exported.provenance.source.first_sample_device_time_us).toBe(expectedDay.provenance.source.first_sample_device_time_us);
      expect(exported).not.toHaveProperty('preview');
    }
    expect(dayPaths[0]).not.toEqual(dayPaths[1]);
    await page.screenshot({ path: testInfo.outputPath('daily-timeseries.png'), fullPage: true });
    await page.getByRole('tab', { name: 'Strides (40)', exact: true }).click();
    await expect(page.locator('#timeseries-panel')).toBeHidden();
    await expect(page.locator('#result-table tbody tr')).toHaveCount(40);

    // Combined is available after completion; table exports include every page and keep the day first.
    await page.locator('#day-select').selectOption('combined');
    await expect(page.locator('#result-table thead th').first()).toHaveText('day');
    await expect(page.getByRole('tab', { name: 'Timeseries', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Save results…' }).click();
    await expect(page.locator('#status')).toHaveText('Results saved.');
    const combined = JSON.parse(await readFile(output));
    expect(combined.provenance.day_runs).toHaveLength(2);
    expect(combined.provenance.view).toBe('combined');
    expect(combined.tables.strides.columns[0]).toBe('day');
    expect([...new Set(combined.tables.strides.rows.map((row) => row[0]))]).toEqual(['2024-01-02', '2024-01-03']);
    const contacts = combined.tables.initial_contacts.rows.length;
    await page.getByRole('tab', { name: `Initial contacts (${contacts})`, exact: true }).click();
    await expect(page.locator('#result-table tbody tr')).toHaveCount(Math.min(100, contacts));
    const csvOutput = testInfo.outputPath('combined-contacts.csv');
    await app.evaluate(({ dialog }, filename) => {
      dialog.showSaveDialog = async (_window, options) => {
        globalThis.csvDefaultPath = options.defaultPath;
        return { canceled: false, filePath: filename };
      };
    }, csvOutput);
    await page.getByRole('button', { name: 'Export table CSV…', exact: true }).click();
    await expect(page.locator('#status')).toHaveText('CSV table saved.');
    const csvTable = await readFile(csvOutput, 'utf8');
    expect(csvTable.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean)).toHaveLength(contacts + 1);
    expect(csvTable).toContain('"day",');
    expect(csvTable).toContain('"2024-01-02",');
    expect(csvTable).toContain('"2024-01-03",');
    expect(await app.evaluate(() => globalThis.csvDefaultPath)).toBe('mobgap-combined-initial_contacts.csv');
    await page.screenshot({ path: testInfo.outputPath('combined-results.png'), fullPage: true });
    await app.evaluate(({ dialog }, filename) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename });
    }, output);

    await choose(app, page, example('HA/001/TimeMeasure1_Test11_Trial1.csv'));
    await page.locator('#recording_start_time').fill('2024-01-02T23:59:30');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('#status')).toHaveText('Processing complete.', { timeout: 60_000 });
    await expect(page.locator('#day-select option')).toHaveCount(3);
    await page.locator('#day-select').selectOption('0');
    await page.getByRole('button', { name: 'Save results…' }).click();
    await expect(page.locator('#status')).toHaveText('Results saved.');
    const csvDay = JSON.parse(await readFile(output));
    expect(csvDay.provenance.calendar_day.sample_start).toBe(0);
    expect(csvDay.provenance.calendar_day.sample_end).toBe(3000);
    expect(csvDay.provenance.samples).toBe(3000);

    await choose(app, page, nativeCases.daily.failed_first_path, 'cwa');
    await participant(page);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('#status')).toHaveText('Processing complete.', { timeout: 60_000 });
    await expect(page.locator('#day-select option').first()).toContainText('(failed)');
    await page.getByRole('tab', { name: 'Timeseries', exact: true }).click();
    await expect(page.locator('#timeseries-plot polyline')).toHaveCount(3);
    await page.locator('#day-select').selectOption('0');
    await expect(page.locator('#warning-list')).toContainText('gyroscope');
    await expect(page.locator('#plot-empty')).toBeVisible();
    await expect(page.locator('#timeseries-plot polyline')).toHaveCount(0);
    await expect(page.locator('#plot-group')).toBeDisabled();
    await page.locator('#day-select').selectOption('1');
    await expect(page.locator('#timeseries-plot polyline')).toHaveCount(3);
    await page.getByRole('tab', { name: 'Strides (40)', exact: true }).click();
    await expect(page.locator('#result-table tbody tr')).toHaveCount(40);
    await page.locator('#day-select').selectOption('combined');
    await expect(page.locator('#warning-list')).toContainText('2024-01-02:');
    await expect(page.locator('#result-table tbody tr')).toHaveCount(40);

    // A real accelerometer-only CWA must not acquire invented gyroscope channels.
    await choose(app, page, path.join(root, '../example_data/data/ax6/example-610-steps.cwa'), 'cwa');
    await participant(page);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('#error-message')).toContainText('gyroscope');
    await expect(page.locator('#run')).toBeEnabled();
    const malformed = testInfo.outputPath('truncated spaced ü.cwa');
    await writeFile(malformed, (await readFile(path.join(root, '.cache/cwa-tests/HA-six-axis.cwa'))).subarray(0, 1100));
    await choose(app, page, malformed, 'cwa');
    await participant(page);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('#error')).toBeVisible();
    await expect(page.locator('#run')).toBeEnabled();

    // Metadata is tied to contents, not an arbitrary matching filename.
    const csv = await readFile(example('HA/001/TimeMeasure1_Test11_Trial1.csv'), 'utf8');
    const invalid = testInfo.outputPath('custom spaced ü.csv');
    await writeFile(invalid, csv.replace('0.9548392163990763', 'invalid'));
    // Ensure the file differs even if the long recording starts with another value.
    const lines = csv.trim().split('\n');
    lines[1] = lines[1].replace(/,([^,]+)/, ',invalid');
    await writeFile(invalid, `${lines.join('\n')}\n`);
    await choose(app, page, invalid);
    await expect(page.locator('#acceleration_unit')).toBeEnabled();
    await expect(page.locator('#example-label')).toHaveText('Custom recording');
    await expect(page.locator('#height_m')).toHaveValue('');
    await page.locator('#sampling_rate_hz').fill('100');
    await page.locator('#acceleration_unit').selectOption('g');
    await page.locator('#cohort').selectOption('HA');
    await page.locator('#height_m').fill('1.59');
    await page.locator('#sensor_height_m').fill('0.964');
    await page.locator('#measurement_condition').selectOption('laboratory');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('#error-message')).toContainText('must contain numeric values');
    await expect(page.locator('#results')).toBeHidden();

    // Terminating the worker must recover a usable interpreter and preserve the chosen recording.
    await choose(app, page, example('HA/001/TimeMeasure1_Test11_Trial1.csv'));
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#status')).toHaveText('Ready to process a recording.', { timeout: 120_000 });
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('#status')).toHaveText('Processing complete.', { timeout: 60_000 });
    // Cancelling a CWA job recreates both runtimes and permits another CWA run.
    await choose(app, page, path.join(root, '.cache/cwa-tests/HA-six-axis.cwa'), 'cwa');
    await participant(page);
    await page.evaluate(() => {
      document.getElementById('settings').requestSubmit();
      document.getElementById('cancel').click();
    });
    await expect(page.locator('#status')).toHaveText('Ready to process a recording.', { timeout: 120_000 });
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('#status')).toHaveText('Processing complete.', { timeout: 60_000 });
    await page.screenshot({ path: testInfo.outputPath('mobgap.png'), fullPage: true });

    // Weartime runs independently of participant metadata and agrees with the native CWA daily oracle.
    await choose(app, page, nativeCases.daily.path, 'cwa');
    await page.locator('#pipeline_type').selectOption('weartime');
    await expect(page.locator('#height_m')).toBeDisabled();
    await expect(page.locator('#cohort')).toBeDisabled();
    await page.locator('#sampling_rate_hz').fill('49');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('#sampling_rate_hz')).toBeFocused();
    await page.locator('#sampling_rate_hz').fill('100');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('#status')).toHaveText('Processing complete.', { timeout: 60_000 });
    await expect(page.locator('#stage-note')).toContainText('WtdMegaritisSignal');
    await expect(page.getByRole('tab', { name: 'Weartime summary (1)', exact: true })).toHaveAttribute('aria-selected', 'true');
    for (const [index, day] of nativeCases.daily.days.entries()) {
      await page.locator('#day-select').selectOption(String(index));
      await page.getByRole('button', { name: 'Save results…' }).click();
      await expect(page.locator('#status')).toHaveText('Results saved.');
      const actual = JSON.parse(await readFile(output));
      const expected = JSON.parse(await readFile(path.join(root, `.cache/cwa-tests/day-${day.date}-weartime-results.json`)));
      for (const [name, table] of Object.entries(expected.tables)) {
        expect(actual.tables[name].columns).toEqual(table.columns);
        expect(actual.tables[name].rows).toHaveLength(table.rows.length);
        for (const [i, row] of table.rows.entries()) for (const [j, value] of row.entries()) {
          if (typeof value === 'number') expect(actual.tables[name].rows[i][j]).toBeCloseTo(value, 6);
          else expect(actual.tables[name].rows[i][j]).toEqual(value);
        }
      }
    }
    await page.locator('#day-select').selectOption('combined');
    await expect(page.locator('#result-table tbody tr')).toHaveCount(2);
    await expect(page.locator('#result-table thead th').first()).toHaveText('day');
    await page.screenshot({ path: testInfo.outputPath('combined-weartime.png'), fullPage: true });
    // CSV also uses the selected analysis; switching back restores required participant controls.
    await choose(app, page, example('HA/001/TimeMeasure1_Test11_Trial1.csv'));
    await page.locator('#recording_start_time').fill('2024-01-02T06:59:30');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('#status')).toHaveText('Processing complete.', { timeout: 60_000 });
    await expect(page.getByRole('tab', { name: 'Weartime summary (1)', exact: true })).toBeVisible();
    await page.locator('#pipeline_type').selectOption('mobilised');
    await expect(page.locator('#cohort')).toBeEnabled();
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
