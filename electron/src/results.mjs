/** Join result tables without recomputing statistics or shifting day-relative sample indices. */
export function combineDayResults(days) {
  if (!days.length) throw new Error('No completed days to combine.');
  const tables = {};
  for (const result of days) {
    for (const [name, table] of Object.entries(result.tables)) {
      tables[name] ??= { columns: ['day'], rows: [] };
      for (const column of table.columns) if (!tables[name].columns.includes(column)) tables[name].columns.push(column);
    }
  }
  for (const result of days) {
    const date = result.provenance.calendar_day.date;
    for (const [name, table] of Object.entries(result.tables)) {
      const positions = new Map(table.columns.map((column, index) => [column, index]));
      for (const row of table.rows) tables[name].rows.push(tables[name].columns.map((column, index) =>
        index === 0 ? date : positions.has(column) ? row[positions.get(column)] : null));
    }
  }
  const first = days.find((day) => !day.status) ?? days[0];
  return {
    schema_version: 1,
    status: 'combined',
    tables,
    warnings: days.flatMap((result) => result.warnings.map((message) => `${result.provenance.calendar_day.date}: ${message}`)),
    provenance: {
      ...first.provenance,
      view: 'combined',
      calendar_day: null,
      source: null,
      samples: days.reduce((sum, result) => sum + result.provenance.samples, 0),
      duration_s: days.reduce((sum, result) => sum + result.provenance.duration_s, 0),
      elapsed_s: days.reduce((sum, result) => sum + result.provenance.elapsed_s, 0),
      sample_index_basis: 'Relative to each calendar-day batch; identify rows by day and their original indices',
      day_runs: days.map((result) => ({ status: result.status ?? 'complete', provenance: result.provenance })),
    },
  };
}
