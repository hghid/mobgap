const { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } = require('electron');
const { handleWindowsInstall } = require('./windows-install.cjs');
if (handleWindowsInstall(app)) return;

const { createHash } = require('node:crypto');
const { open, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { MAX_INPUT_BYTES, APP_ORIGIN, isTrustedURL, assetName, validateExport, websiteURL } = require('./contracts.cjs');

protocol.registerSchemesAsPrivileged([{
  scheme: 'mobgap', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

const appRoot = path.join(__dirname, '..');
const contentSecurityPolicy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json', '.py': 'text/plain', '.png': 'image/png' };
let window;
let examples;

function requireSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
      !isTrustedURL(event.senderFrame.url)) throw new Error('Untrusted application request.');
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1150, height: 820, minWidth: 760, minHeight: 600, title: 'MobGap', backgroundColor: '#f4f6f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, nodeIntegrationInWorker: false,
      contextIsolation: true, sandbox: true, webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('closed', () => { window = null; });
  await window.loadURL(`${APP_ORIGIN}/src/index.html`);
}

app.whenReady().then(async () => {
  app.setAppUserModelId(process.platform === 'win32' ? 'com.squirrel.MobGap.mobgap' : 'org.mobilise-d.mobgap');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(appRoot, 'runtime/manifest.json')));
    examples = JSON.parse(await readFile(path.join(appRoot, 'runtime/example-metadata.json')));
  } catch {
    dialog.showErrorBox('Runtime not prepared', 'Run npm run runtime:prepare in electron/ before starting MobGap.');
    app.quit();
    return;
  }
  const allowed = new Set(['src/index.html', 'src/styles.css', 'src/renderer.mjs', 'src/worker.mjs', 'src/cwa-import.mjs',
    'src/timeseries.mjs', 'src/timeseries-plot.mjs', 'src/inkspot-logo.png',
    'runtime/manifest.json', ...Object.keys(manifest.integrity).map((name) => `runtime/${name}`)]);
  protocol.handle('mobgap', async (request) => {
    const name = assetName(request.url, allowed);
    if (request.method !== 'GET' || !name) return new Response('Not found', { status: 404 });
    try {
      const bytes = await readFile(path.join(appRoot, name));
      return new Response(bytes, { headers: {
        'Content-Type': mime[path.extname(name)] || 'application/octet-stream',
        'Content-Security-Policy': contentSecurityPolicy,
        'X-Content-Type-Options': 'nosniff',
      } });
    } catch { return new Response('Asset unavailable', { status: 404 }); }
  });
  // Processing is entirely local. Block accidental CDN/package fetches as well as renderer networking.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isTrustedURL(details.url) && !details.url.startsWith('devtools://') });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  ipcMain.handle('website:open', async (event, site) => {
    requireSender(event);
    await shell.openExternal(websiteURL(site));
  });

  async function chooseRecording(event, format) {
    requireSender(event);
    const chosen = await dialog.showOpenDialog(window, {
      title: 'Choose an IMU recording', properties: ['openFile'],
      filters: [{ name: `${format.toUpperCase()} recordings`, extensions: [format] }],
    });
    if (chosen.canceled || chosen.filePaths.length !== 1) return null;
    const filename = chosen.filePaths[0];
    if (path.extname(filename).toLowerCase() !== `.${format}`) throw new Error(`Choose a .${format} recording.`);
    const file = await open(filename, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('Choose a regular recording file.');
      if (format === 'csv' && stat.size > MAX_INPUT_BYTES) throw new Error('Choose a CSV recording smaller than 64 MiB.');
      // Read the selected file snapshot plus one byte to detect growth during reading.
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > stat.size) throw new Error('The file changed during reading. Choose it again.');
      const bytes = buffer.subarray(0, length);
      const digest = createHash('sha256').update(bytes).digest('hex');
      return { name: path.basename(filename), format, bytes: new Uint8Array(bytes), example: format === 'csv' ? examples[digest] || null : null };
    } finally { await file.close(); }
  }
  ipcMain.handle('csv:choose', (event) => chooseRecording(event, 'csv'));
  ipcMain.handle('results:save', async (event, text) => {
    requireSender(event);
    const contents = validateExport(text);
    const date = JSON.parse(contents).provenance.calendar_day?.date;
    const defaultPath = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? `mobgap-${date}-results.json` : 'mobgap-results.json';
    const chosen = await dialog.showSaveDialog(window, {
      title: 'Save selected day results and run metadata', defaultPath,
      filters: [{ name: 'JSON results', extensions: ['json'] }],
    });
    if (chosen.canceled || !chosen.filePath) return false;
    await writeFile(chosen.filePath, contents, 'utf8');
    return true;
  });
  await createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) void createWindow(); });
}).catch((error) => {
  dialog.showErrorBox('Could not start MobGap', error.message);
  app.quit();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
