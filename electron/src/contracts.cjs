const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
const APP_ORIGIN = 'mobgap://app';
const websites = new Map([
  ['inkspot', 'https://inkspot.science/'],
  ['mobgap', 'https://github.com/mobilise-d/mobgap'],
]);

function websiteURL(site) {
  const url = websites.get(site);
  if (!url) throw new Error('Unknown website.');
  return url;
}

function isTrustedURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'mobgap:' && url.hostname === 'app' && !url.port && !url.username && !url.password;
  } catch { return false; }
}

function assetName(value, allowed) {
  const url = new URL(value);
  if (!isTrustedURL(value)) return null;
  let name;
  try { name = decodeURIComponent(url.pathname).replace(/^\//, ''); } catch { return null; }
  return allowed.has(name) ? name : null;
}

function validateExport(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_EXPORT_BYTES) throw new Error('Result export is too large.');
  const value = JSON.parse(text);
  if (value.schema_version !== 1 || !value.tables || !value.provenance) throw new Error('Invalid result export.');
  return text;
}

/** Encode the complete current table, including rows outside the visible page, as UTF-8 CSV. */
function tableCsvExport(payload) {
  if (!payload || !/^[a-z_]{1,40}$/.test(payload.name) ||
      !/^(combined|\d{4}-\d{2}-\d{2})$/.test(payload.day)) throw new Error('Invalid CSV export name.');
  const table = payload.table;
  if (!table || !Array.isArray(table.columns) || !table.columns.length ||
      !table.columns.every((column) => typeof column === 'string') || !Array.isArray(table.rows) ||
      !table.rows.every((row) => Array.isArray(row) && row.length === table.columns.length)) {
    throw new Error('Invalid result table.');
  }
  const quote = (value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid CSV numeric value.');
    const text = value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `"${text.replaceAll('"', '""')}"`;
  };
  const contents = '\uFEFF' + [table.columns, ...table.rows].map((row) => row.map(quote).join(',')).join('\r\n') + '\r\n';
  if (Buffer.byteLength(contents) > MAX_EXPORT_BYTES) throw new Error('CSV export is too large.');
  return { contents, filename: `mobgap-${payload.day}-${payload.name}.csv` };
}

module.exports = { MAX_INPUT_BYTES, MAX_EXPORT_BYTES, APP_ORIGIN, isTrustedURL, assetName, validateExport, websiteURL, tableCsvExport };
