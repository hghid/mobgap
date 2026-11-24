import { test, expect, _electron as electron } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('edit, run and save a trusted daily Python analysis', async ({}, info) => {
  const executablePath = process.env.MOBGAP_EXECUTABLE || electronPath;
  const app = await electron.launch({ executablePath, args: process.env.MOBGAP_EXECUTABLE ? [] : ['.'], cwd: root });
  try {
    const page = await app.firstWindow();
    await page.locator('#open-workspace').click();
    const csv = path.resolve(root, '../example_data/data_csv/MS/001/TimeMeasure1_Test11_Trial1.csv');
    await app.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
    }, csv);
    await page.locator('#choose').click();
    await page.locator('#recording_start_time').fill('2024-01-02T12:00');
    await page.locator('#pipeline_type').selectOption('custom');
    await expect(page.locator('#script-source')).toHaveValue(/MobilisedPipelineImpaired/);
    await page.locator('#run').click();
    await expect(page.locator('#status')).toHaveText('Processing complete.');
    await expect(page.locator('#tab-strides')).toContainText(/[1-9]/);

    const source = 'import pandas as pd\ndef analyze_day(data, *, height_m, sensor_height_m, condition, sampling_rate_hz, cohort):\n    return {"summary": pd.DataFrame([{"n": len(data), "rate": sampling_rate_hz}])}\n';
    await page.locator('#script-file').setInputFiles({ name: 'study.py', mimeType: 'text/plain', buffer: Buffer.from(source) });
    const edited = source.replace('"rate": sampling_rate_hz', '"height": height_m');
    await page.locator('#script-source').fill(edited);
    async function saveTo(button, filename) {
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      }, filename);
      await page.locator(button).click();
      await expect.poll(async () => readFile(filename, 'utf8').catch(() => '')).not.toBe('');
      return readFile(filename, 'utf8');
    }
    expect(await saveTo('#script-save', info.outputPath('study.py'))).toBe(edited);
    await page.locator('#run').click();
    await expect(page.locator('#tab-summary')).toHaveText('summary (1)');
    await page.locator('#day-select').selectOption('combined');
    const result = JSON.parse(await saveTo('#save', info.outputPath('results.json')));
    expect(result.tables.summary.columns).toEqual(['day', 'index', 'n', 'height']);
    expect(result.tables.summary.rows[0][3]).toBe(result.provenance.options.height_m);
    expect(result.provenance.options.script_sha256).toBe(createHash('sha256').update(edited).digest('hex'));

    await page.locator('#script-source').fill('def broken(');
    await page.locator('#run').click();
    await expect(page.locator('#error-details')).toContainText('SyntaxError');
    await page.locator('#script-source').fill(source);
    await page.locator('#run').click();
    await expect(page.locator('#status')).toHaveText('Processing complete.');

    for (const [mode, template, table] of [
      ['mobilised', /GaitDatasetFromData/, 'strides'],
      ['bam', /Recording4/, 'walking_bout_mask'],
      ['weartime', /WtdMegaritisSignal/, 'weartime_summary'],
    ]) {
      await page.locator('#pipeline_type').selectOption(mode);
      await page.locator('#script-toggle').check();
      await expect(page.locator('#script-source')).toHaveValue(template);
      await page.locator('#run').click();
      await expect(page.locator('#status')).toHaveText('Processing complete.');
      await expect(page.locator(`#tab-${table}`)).toBeVisible();
    }
    await page.locator('#script-source').fill(source);
    await page.locator('#run').click();
    await expect(page.locator('#tab-summary')).toHaveText('summary (1)');
    await page.locator('#pipeline_type').selectOption('bam');
    await expect(page.locator('#script-source')).toHaveValue(/Recording4/);
    await page.locator('#pipeline_type').selectOption('weartime');
    await expect(page.locator('#script-source')).toHaveValue(source);
  } finally { await app.close(); }
});
