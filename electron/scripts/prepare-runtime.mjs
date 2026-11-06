import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, glob, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPyodide } from 'pyodide';

process.on('uncaughtException', (error) => { console.error(error.message); process.exit(1); });

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = path.join(root, 'runtime');
const packageRoot = path.join(root, 'node_modules/pyodide');
const packageInfo = JSON.parse(await readFile(path.join(packageRoot, 'package.json')));
const cdn = `https://cdn.jsdelivr.net/pyodide/v${packageInfo.version}/full/`;
const lockPath = path.join(root, 'runtime-lock.json');
const update = process.argv.includes('--update-lock');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function dependencyClosure(lock) {
  const packages = {};
  function include(name) {
    if (packages[name]) return;
    const entry = lock.packages[name];
    if (!entry) throw new Error(`Unresolved runtime dependency: ${name}`);
    packages[name] = entry;
    entry.package_type ||= 'package';
    for (const dep of entry.depends) include(dep);
  }
  include('mobgap');
  return { ...lock, packages };
}

await mkdir(runtime, { recursive: true });
const built = spawnSync(process.env.UV || 'uv', ['build', '--wheel', '--out-dir', runtime], {
  cwd: path.join(root, '..'), stdio: 'inherit',
});
if (built.error) throw built.error;
if (built.status !== 0) throw new Error('Building the MobGap wheel failed. Install uv and retry.');
const project = JSON.parse(await readFile(path.join(root, 'package.json')));
if (project.devDependencies.pyodide !== packageInfo.version) throw new Error('Run npm ci to install pinned Pyodide.');
const wheelFiles = (await readdir(runtime)).filter((name) => /^mobgap-.*\.whl$/.test(name));
// uv builds the version declared in pyproject.toml. Ignore old runtime builds.
const pyproject = await readFile(path.join(root, '../pyproject.toml'), 'utf8');
const version = pyproject.match(/^version = "([^"]+)"/m)[1];
const wheel = wheelFiles.find((name) => name === `mobgap-${version}-py3-none-any.whl`);
if (!wheel) throw new Error('Expected a pure Python MobGap wheel.');
const wheelBytes = await readFile(path.join(runtime, wheel));

for (const file of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip']) {
  await copyFile(path.join(packageRoot, file), path.join(runtime, file));
}
await copyFile(path.join(root, 'python/adapter.py'), path.join(runtime, 'adapter.py'));
const cwaRoot = path.join(root, 'node_modules/@mobilise-d/cwa-reader');
const cwaBuild = JSON.parse(await readFile(path.join(cwaRoot, 'build-metadata.json')));
const cwaPackage = JSON.parse(await readFile(path.join(cwaRoot, 'package.json')));
if (cwaPackage.version !== '0.5.0' || cwaBuild.source_dirty ||
    cwaBuild.source_revision !== '68b2369140cd7bec0c2ffbbea368ae7e294084dc' ||
    cwaBuild.target !== 'wasm32-unknown-unknown') throw new Error('Unexpected CWA reader build provenance.');
const cwaFiles = ['package.json', 'cwa_reader_browser.js', 'cwa_reader_browser_bg.wasm', 'build-metadata.json', 'LICENSE'];
await mkdir(path.join(runtime, 'cwa'), { recursive: true });
for (const file of cwaFiles) {
  const bytes = await readFile(path.join(cwaRoot, file));
  if (file !== 'build-metadata.json' && hash(bytes) !== cwaBuild.sha256[file]) throw new Error(`CWA reader integrity mismatch: ${file}`);
  await writeFile(path.join(runtime, 'cwa', file), bytes);
}
const metadata = JSON.parse(await readFile(path.join(root, '../example_data/data_csv/participant_metadata.json')));
const examples = {};
for await (const file of glob('*/*/*.csv', { cwd: path.join(root, '../example_data/data_csv') })) {
  const [cohort, participant] = file.split(path.sep);
  const digest = hash(await readFile(path.join(root, '../example_data/data_csv', file)));
  examples[digest] = { label: `${cohort} / ${participant}`, ...metadata[cohort][participant],
    sampling_rate_hz: 100, acceleration_unit: 'g', measurement_condition: 'laboratory' };
}
await writeFile(path.join(runtime, 'example-metadata.json'), `${JSON.stringify(examples, null, 2)}\n`);

let lock;
if (update) {
  const py = await loadPyodide({ indexURL: packageRoot, packageCacheDir: runtime });
  await py.loadPackage('micropip');
  py.FS.writeFile(`/${wheel}`, wheelBytes);
  py.globals.set('project_wheel', `emfs:/${wheel}`);
  await py.runPythonAsync(`
import json
import micropip
await micropip.install(project_wheel)
from importlib.metadata import distributions, version, PackageNotFoundError
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

# The upstream catalog can omit dependencies expressed only in wheel metadata
# (e.g. pandas' Emscripten tzdata marker). Resolve those as well.
for _ in range(10):
    missing = set()
    metadata_dependencies = {}
    for dist in distributions():
        names = []
        for text in dist.requires or []:
            req = Requirement(text)
            if req.marker and not req.marker.evaluate({"extra": ""}):
                continue
            names.append(canonicalize_name(req.name))
            try:
                installed = version(req.name)
            except PackageNotFoundError:
                missing.add(str(req))
                continue
            if not req.specifier.contains(installed, prereleases=True):
                missing.add(str(req))
        metadata_dependencies[canonicalize_name(dist.name)] = names
    if not missing:
        break
    await micropip.install(sorted(missing))
else:
    raise RuntimeError("Unable to resolve wheel metadata dependencies")
`);
  // freeze includes Pyodide's entire package catalog; retain only MobGap's dependency closure.
  lock = JSON.parse(py.runPython('micropip.freeze()'));
  const metadataDependencies = JSON.parse(py.runPython('json.dumps(metadata_dependencies)'));
  for (const [name, entry] of Object.entries(lock.packages)) {
    entry.depends = [...new Set([...entry.depends, ...(metadataDependencies[name] || [])])].sort();
  }
  lock = dependencyClosure(lock);
  const official = JSON.parse(await readFile(path.join(packageRoot, 'pyodide-lock.json')));
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name === 'mobgap') {
      entry.file_name = wheel;
      delete entry.sha256;
    } else if (!entry.file_name.startsWith('https://')) {
      entry.file_name = new URL(official.packages[name].file_name, cdn).href;
    }
  }
  lock.pyodide = packageInfo.version;
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
} else {
  lock = JSON.parse(await readFile(lockPath));
}
if (lock.pyodide !== packageInfo.version) throw new Error('Runtime lock does not match Pyodide. Run npm run runtime:lock.');

const localLock = structuredClone(lock);
delete localLock.pyodide;
localLock.packages.mobgap.file_name = wheel;
localLock.packages.mobgap.version = version;
localLock.packages.mobgap.sha256 = hash(wheelBytes);
for (const [name, entry] of Object.entries(lock.packages)) {
  if (name === 'mobgap') continue;
  const filename = path.basename(new URL(entry.file_name).pathname);
  const destination = path.join(runtime, filename);
  let bytes;
  try { bytes = await readFile(destination); } catch { /* not cached */ }
  if (!bytes || hash(bytes) !== entry.sha256) {
    console.log(`Bundling ${name} ${entry.version}`);
    const response = await fetch(entry.file_name);
    if (!response.ok) throw new Error(`Download failed for ${name}: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== entry.sha256) throw new Error(`Integrity mismatch for ${name}`);
    await writeFile(destination, bytes);
  }
  localLock.packages[name].file_name = filename;
}
await writeFile(path.join(runtime, 'pyodide-lock.json'), `${JSON.stringify(localLock, null, 2)}\n`);

// Validate the assembled runtime, rather than relying only on the catalog's dependency list.
// A normal preparation must succeed without fetching any package after bundling.
const originalFetch = globalThis.fetch;
let notices;
try {
  globalThis.fetch = async (url) => { throw new Error(`Unexpected runtime network request: ${url}`); };
  const py = await loadPyodide({ indexURL: runtime, packageCacheDir: runtime, packageBaseUrl: runtime,
    stdout: () => {}, stderr: () => {} });
  await py.loadPackage('mobgap');
  py.globals.set('adapter_source', await readFile(path.join(runtime, 'adapter.py'), 'utf8'));
  await py.runPythonAsync(`
import warnings
with warnings.catch_warnings(record=True):
    warnings.simplefilter("ignore")
    exec(compile(adapter_source, "adapter.py", "exec"), globals())
validate_runtime()
`);
  notices = py.runPython(`
parts = []
for dist in sorted(distributions(), key=lambda item: item.name.lower()):
    parts.append(f"{dist.name} {dist.version}")
    parts.append("License: " + (dist.metadata.get("License-Expression") or dist.metadata.get("License") or "See distribution notices"))
    parts.extend(dist.metadata.get_all("Project-URL") or [])
    for file in dist.files or []:
        name = str(file)
        if ".dist-info/" in name and any(token in name.lower() for token in ("license", "copying", "notice")):
            try:
                parts.append("--- " + name + " ---\\n" + dist.locate_file(file).read_text(errors="replace"))
            except (OSError, UnicodeError):
                pass
    parts.append("")
"\\n".join(parts)
`);
} finally { globalThis.fetch = originalFetch; }
for (const file of ['PYODIDE-MPL-2.0.txt', 'CPYTHON-LICENSE.txt']) {
  notices += `\n\n--- ${file} ---\n${await readFile(path.join(root, 'licenses', file), 'utf8')}`;
}
notices += `\n\n--- @mobilise-d/cwa-reader ${cwaPackage.version} ---\n${await readFile(path.join(cwaRoot, 'LICENSE'), 'utf8')}`;
await writeFile(path.join(runtime, 'THIRD_PARTY_NOTICES.txt'), notices);
const assets = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'adapter.py', 'example-metadata.json',
  'pyodide-lock.json', 'THIRD_PARTY_NOTICES.txt', ...cwaFiles.map((file) => `cwa/${file}`),
  ...Object.values(localLock.packages).map((entry) => entry.file_name)];
const integrity = {};
for (const file of assets) integrity[file] = hash(await readFile(path.join(runtime, file)));
await writeFile(path.join(runtime, 'manifest.json'), `${JSON.stringify({
  pyodide: packageInfo.version, mobgap: version, python: lock.info.python,
  cwa_reader: { version: cwaPackage.version, ...cwaBuild },
  packages: Object.fromEntries(Object.entries(localLock.packages).map(([name, entry]) => [name, entry.version])),
  integrity,
}, null, 2)}\n`);
for (const file of await readdir(runtime)) {
  if (!assets.includes(file) && !assets.some((asset) => asset.startsWith(`${file}/`)) && file !== 'manifest.json') await unlink(path.join(runtime, file));
}
console.log(`Offline runtime prepared: ${Object.keys(localLock.packages).length} packages.`);
