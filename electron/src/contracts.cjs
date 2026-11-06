const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
const APP_ORIGIN = 'mobgap://app';

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

module.exports = { MAX_INPUT_BYTES, MAX_EXPORT_BYTES, APP_ORIGIN, isTrustedURL, assetName, validateExport };
