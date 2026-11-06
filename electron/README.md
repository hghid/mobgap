# MobGap desktop

A small Electron application running the repository's Python code in Pyodide, inside a Web Worker.
It uses `MobilisedPipelineUniversal` with the default healthy and impaired pipelines from
[`examples/pipeline/_03_preconfigured_mobilised_pipelines.py`](../examples/pipeline/_03_preconfigured_mobilised_pipelines.py).
The installed application contains Python, WebAssembly, the MobGap wheel, models, scientific dependencies,
and the Rust/WebAssembly CWA reader.
It needs no system Python or network connection to process a recording.

## Build and run

For development, install **Node.js 22.17 or newer**, npm, and [uv](https://docs.astral.sh/uv/getting-started/installation/).
These tools are build requirements; people using a packaged app do not need them.
From this directory:

```sh
npm ci
npm run runtime:prepare
npm start
```

The first two commands require internet access. Runtime preparation builds the current repository's wheel using
`pyproject.toml`, downloads the versions in `runtime-lock.json`, verifies their SHA-256 hashes, copies the pinned
CWA reader from its npm release package, verifies its compiler/source manifest and file hashes, and assembles
`runtime/`. Rerun `runtime:prepare` after changing the Python source or adapter. It reuses verified downloads.
Set the `UV` environment variable to an executable path if uv is not on PATH.

To create a standalone application and a ZIP for the current OS and CPU architecture:

```sh
npm run make
npm run test:packaged
```

To build the Windows x64 ZIP or macOS Apple silicon ZIP explicitly:

```sh
npm run make -- --platform=win32 --arch=x64
npm run make -- --platform=darwin --arch=arm64
```

Both commands have been used on macOS arm64. Windows can be cross-packaged because the processing runtime
is WebAssembly and its dependencies are bundled. Run `npm run test:packaged` on a Windows x64 machine to
check the Windows executable; a successful cross-build does not verify Windows launch or processing.

Unpack the ZIP in `out/make/zip/` and launch the application. On macOS, copy `MobGap.app` to Applications;
on Windows, launch `mobgap.exe` inside the extracted directory; on Linux, launch `mobgap`.
Keep the extracted application files together. These initial builds are unsigned development distributions.
Public distribution still requires platform signing/notarization and release verification.

### Windows installer

On a **Windows x64 build machine**, `npm run make` produces both the portable ZIP and a Squirrel installer.
To request just the installer after preparing the runtime:

```sh
npm run make:windows:installer
```

The intended output is `out/make/squirrel.windows/x64/MobGapSetup.exe`, together with a full `.nupkg` and
`RELEASES` metadata. The setup executable contains the application and processing runtime. Squirrel installs
per user, creates shortcuts, and registers an uninstall entry. The app handles install, update, and uninstall
startup events before initializing Electron windows or Python. No update server is configured.

This build configuration uses the pinned `@electron-forge/maker-squirrel` and the existing Forge toolchain.
The [Electron Forge Squirrel requirements](https://www.electronforge.io/config/makers/squirrel.windows)
require Windows, or Linux with Wine and Mono. This repository enables the installer maker on Windows;
macOS cross-builds continue to produce the ZIP. The Windows CI job builds the installer and uploads it with
the ZIP and update metadata. An installer has **not yet been generated or installed in this local session**;
the Windows build and install/uninstall checks remain required. Installer lifecycle unit tests run on all hosts.
The initial installer is unsigned, as are the portable development builds.

### Windows development and validation

Use x64 Node.js 24 (the version configured in CI) and uv. From the repository root, in PowerShell:

```powershell
uv sync --locked --no-dev --group test --python 3.14
Set-Location electron
npm ci
npm run runtime:prepare
uv pip install --target .cache/cwa-native --no-deps cwa-reader-rs==0.5.0
npm test
npm run test:adapter
npm run test:cwa
npm run test:parity
npm run test:e2e
npm run make
npm run test:packaged
```

These are the Windows counterparts of the locally verified macOS commands; native Windows execution is
still pending. Runtime preparation downloads build assets, while the prepared app processes data offline.
No Python environment, Rust compiler, or Node.js installation is needed by end users.

`npm run make` on Windows requests the ZIP and installer. After the packaged tests, verify installation with
`out/make/squirrel.windows/x64/MobGapSetup.exe`, shortcuts, offline CSV/CWA processing, day selection,
timeseries sensor selection, JSON export, and uninstall. The packaged test currently exercises the unpacked
application, so it does not establish successful installation or removal. Test fixtures are generated locally
from the tracked example CSVs; generated runtimes, fixtures, screenshots, and distributions are not in Git.

`runtime/`, `node_modules/`, test output, and `out/` are generated and ignored by Git.
The JavaScript and Python runtime locks are committed. Installers do not access the repository or its virtualenv.

## Import and process a recording

The app opens on an Inkspot Science start screen with the supplied logo, an overview of the Observational
Study Manager platform, and attribution to the Apache-licensed MobGap toolbox and its contributors.
The Inkspot Science and upstream MobGap links open in the system browser when clicked. These two fixed
destinations are exposed through a validated main-process operation; processing continues to block remote
requests inside the application.

1. Select **Analyse .CWA File** to enter the workspace and immediately open the CWA file chooser. This works
   while the local runtime starts; processing waits for runtime readiness and valid participant metadata.
   Canceling the chooser leaves the workspace available. **Open analysis workspace** enters without a chooser,
   and **Back to start** returns to the start screen while preserving the selected recording and completed results.
   Within the workspace, choose a recording with **Choose CSV…** or **Choose CWA…**. For CSV, try
   [`HA/001/TimeMeasure1_Test11_Trial1.csv`](../example_data/data_csv/HA/001/TimeMeasure1_Test11_Trial1.csv)
   or [`MS/001/TimeMeasure1_Test11_Trial1.csv`](../example_data/data_csv/MS/001/TimeMeasure1_Test11_Trial1.csv).
2. Check the recording and participant settings. Exact matches to any of the nine repository examples are
   recognised by SHA-256 and use their companion participant metadata, 100 Hz sampling, acceleration in g,
   and laboratory measurement conditions. Renaming a file does not change recognition. A different file with
   the same name does not inherit example metadata. For CWA, enter cohort, participant height, sensor height,
   and measurement condition. The sensor file does not supply those participant measurements.
   **Resample CWA to (Hz)** is the processing rate, defaulting to 100 Hz; acceleration units are fixed to g by
   the decoder. The CWA header's configured sample rate is retained separately in the exported provenance.
   For CSV, also enter the recording's actual start date/time on the device clock. CSV samples have no wall-clock
   timestamps, so the app cannot infer their midnight boundaries, including for the bundled examples.
3. Select **Run pipeline**. HA, COPD, and CHF use `MobilisedPipelineHealthy`; MS, PD, and PFF use
   `MobilisedPipelineImpaired`. The pipeline uses its preconfigured algorithms and thresholds.
4. The app splits at **midnight on the device clock**, with shorter first and last batches. Every interior batch
   runs midnight to midnight. Use **Calendar day** to select a completed day's results, then view aggregated
   parameters, walking bouts, strides, gait sequences, and initial contacts using the tabs.
   Tables paginate at 100 rows. Displayed floats are rounded to six decimal places; hover for the exported
   value. Missing values display as `—`.
   For CWA, the **Timeseries** tab shows the selected day's X/Y/Z traces. Use **Sensor values** to switch
   between accelerometer (g) and gyroscope (°/s). The plot uses decoded samples at the selected resampling
   rate, before pipeline filtering or body-frame conversion. Min/max subsampling preserves peaks with at most
   2,000 points per axis; the caption shows the decoded sample count and device-clock range.
   Switching calendar days updates the plot while keeping the chosen sensor group.
5. **Save results…**, beside **Calendar day**, exports the selected day's JSON, with a date-based filename, containing all table rows,
   day boundaries, day-relative sample indices, processing notices, settings, original input hash, pipeline parameters,
   and package/runtime versions. It does not export raw recordings or plot previews. Export other days using the day selector.

Progress reports initialization, CWA packet decoding, validation, pipeline execution, and table preparation.
CWA decoding reports the number of output samples for the current day. The bar is indeterminate
during computation; it does not estimate the percentage completed. Cancellation terminates and recreates the
worker, leaving the selected recording available for another run. Preparation and each individual day have a
ten-minute timeout; the timeout resets when a new day starts. Completed days remain visible during subsequent work.

## Input contract and limits

CSV input must have a header and these columns:

```text
samples,acc_x,acc_y,acc_z,gyr_x,gyr_y,gyr_z
```

- `samples` must be a contiguous zero-based sample sequence without duplicates or gaps.
- All six sensor channels must be finite numbers. Accelerometer-only files cannot run these preconfigured pipelines.
- Axes must match the aligned lower-back sensor frame used by the examples. MobGap converts this to its body frame;
  the app does not detect or correct arbitrary sensor mounting.
- Explicitly select acceleration in **g** or **m/s²**. Gyroscope data must already be in **degrees/second**.
- For custom files, enter sampling rate, cohort, participant height, sensor height, and measurement condition.
  Heights are in metres. These values are not inferred from signal values or filenames.
- Neither CSV nor CWA has an application sample-count cap. Input is split into calendar days, independently
  processed with a fresh pipeline per day. Pipeline/filter state does not continue across midnight, and walking
  bouts crossing midnight can be split; results can therefore differ from processing the whole file at once.
- CSV files are limited to **64 MiB** and are loaded into memory, then sliced into calendar days. CWA files have
  no application file-size cap. CWA selection supplies a read-only browser `File` to the worker; metadata reads
  seek to boundary packets and sample reads request only the current day's ranges in bounded packet batches.
  The original-file SHA-256 is computed once using 4 MiB reads. A multi-day CWA is never copied into one input
  buffer or staged as a complete Python recording. Decoded arrays and Python proxies are released between days.
  A complete day's samples and results still need memory, so available memory and runtime allocation limits apply.
- Very short first/last batches containing fewer than **5 seconds** are reported as `skipped`, with a notice and
  no invented pipeline results. Failed days are labelled separately and do not prevent later days from running.
- All date arithmetic uses the naive device clock. No host timezone, UTC conversion, or daylight-saving offset
  is inferred. Interior days have 24 hours; first and last days follow the available recording bounds.
- A successful run may have no qualifying walking bouts. Many aggregate statistics are unavailable for short
  recordings. This is a valid pipeline result.
- CWA requires measured accelerometer and gyroscope channels in the selected data. The repository's real
  `example_data/data/ax6/example-610-steps.cwa` is an accelerometer-only AX3 file and is rejected for these
  preconfigured pipelines. Gyroscope channels are never fabricated. Missing/invalid sensor measurements are errors.
- CWA processing uses the shared Rust reader's cubic interpolation on a regular output grid, before conversion
  from g to m/s² in Python. It does not correct mounting orientation or infer participant metadata.
- Exact CWA timestamps are retained as signed integer microseconds at the importer boundary. Exported provenance
  includes the first/last decoded timestamp as strings, the header, units, and resampling method. These timestamps
  refer to the naive device clock; no timezone or UTC offset is inferred.
- Batch processing of multiple recordings, time-window selection, and other tools are outside the current interface.

## Runtime and compatibility

Electron **45.2.3** and Pyodide **314.0.7** are pinned in `package-lock.json`. `runtime-lock.json` records the
complete desktop Python dependency graph, including URLs and hashes. The generated `runtime/manifest.json`
records the local MobGap wheel hash, Python version, installed versions, and bundled asset hashes. The desktop
runtime uses Pyodide's compiled wheels, which can differ from versions selected by the native `uv.lock`.

Numba/LLVM is excluded only for Emscripten. `mobgap._utils_internal.numba_backend` uses the existing Python
kernel bodies and serial rowwise peak counting in WebAssembly. Native Python retains the original Numba
decorators, signatures, parallel gufuncs, and typed interval lists. No fake Numba module is installed and the
pipeline algorithms are not replaced.

CWA decoding uses the upstream [`@mobilise-d/cwa-reader` 0.5.0 release](https://github.com/mobilise-d/cwa_reader_rs/releases/tag/v0.5.0),
which already provides a WebAssembly bridge over the same Rust `cwa-core` used by native Python. We reuse this
port instead of maintaining another parser. Its immutable npm archive is pinned by URL and npm integrity;
runtime preparation also checks source revision `68b2369140cd7bec0c2ffbbea368ae7e294084dc` and per-file hashes.
It was compiled for `wasm32-unknown-unknown` with Rust 1.90.0 and wasm-bindgen 0.2.129. Build provenance and the
MIT license ship with the application. This standalone Wasm module runs beside Pyodide; it does not depend on
Pyodide's Emscripten ABI or install the native Python extension. End users and normal app builders need no Rust
compiler. See the pinned [upstream build instructions](https://github.com/mobilise-d/cwa_reader_rs/blob/68b2369140cd7bec0c2ffbbea368ae7e294084dc/wasm/README.md)
to rebuild the shared parser from source. An upgrade must deliberately update the pinned version/revision and
pass decoding and pipeline parity checks.

All packages load from bundled assets. Python runs serially inside the worker; there is no Python subprocess,
server, or process pool. A sandboxed renderer uses named preload methods for the CSV dialog and saving JSON.
CWA uses the browser's file picker and read-only File API, keeping native filesystem APIs out of the renderer.
A restricted application protocol serves allowlisted assets with a CSP; remote requests are blocked.
Recordings are held in memory and released when replaced or the app closes. Nothing uploads them or persists
raw recordings to application storage. Explicit result exports include the selected file's basename.

The bundled Ullrich model was saved with scikit-learn 1.6.1; Pyodide supplies 1.8.0. Its version warnings remain
visible in processing notices and exports. Numerical parity has been checked on the nine supplied recordings;
that is not evidence for every possible recording or an upgrade of the model's scientific validation.

For a deliberate runtime upgrade, update the pinned dependency, install it, resolve a new lock, and rerun verification:

```sh
npm run runtime:lock
npm run test:runtime
npm run test:parity
npm run test:cwa
npm run test:e2e
npm run make
npm run test:packaged
```

`runtime:lock` resolves dependencies inside the selected Pyodide interpreter, checks wheel metadata and environment
markers, and freezes the transitive dependency closure. This catches requirements absent from the upstream catalog,
including pandas' Emscripten timezone data. Normal preparation uses the frozen versions without resolving new ones.
Do not remove requirements or disable dependency checks to make a runtime upgrade pass.

## Verification

Install the native comparison environment from the repository root:

```sh
uv sync --locked --no-dev --group test
```

Then, from `electron/`:

```sh
uv pip install --target .cache/cwa-native --no-deps cwa-reader-rs==0.5.0
npm test
npm run test:adapter
npm run test:runtime
npm run test:parity
npm run test:cwa
npm run test:e2e
npm run make
npm run test:packaged
```

`test:runtime` starts a fresh Pyodide interpreter with all network fetches disabled, verifies asset hashes and
installed requirement metadata, and runs the long healthy and MS examples. `test:parity` compares all five
output tables on all nine CSVs against native CPython: indices, interval boundaries, and labels match exactly;
numeric values use `rtol=1e-7` and `atol=1e-8`. Set `MOBGAP_PYTHON` to use another native environment instead
of the repository's `.venv`.

`test:cwa` uses an isolated native 0.5.0 reader in `.cache/cwa-native` as the oracle. Its scientific dependencies
come from the existing native comparison environment; that test-only install does not alter MobGap's native
optional dependency or the application runtime. Without the isolated oracle it compares against the installed
repository reader (0.4.0). The test generates synthetic six-axis CWA packets from the example CSV signals and
also decodes the real AX3 fixture. At 100 and 60 Hz, it checks exact microsecond timestamps and float32 channel
values (`rtol=1e-6`, `atol=1e-6`), then compares all five pipeline tables using the CSV parity tolerances.
It also checks malformed inputs, absent gyro channels, complete recordings above 500,000 samples, and reuse after errors. Generated CWA
files and native arrays live in ignored `.cache/cwa-tests`; they are not included in the app.
Daily cuts and their pipeline tables are compared against independent native reads using the same midnight
windows. CSV tests cover exact midnight sample assignment, leap-day windows, complete interior days, and short edges.

Playwright launches the actual Electron app and checks the start screen and bundled logo, system-browser links,
the start button's CWA chooser and cancellation, file selection, metadata recognition, both pipelines,
tables, CWA decoding, midnight splitting, per-day selection/export and signal plots, malformed input, cancellation, and recovery. Tests generate their CWA fixtures
using the native test environment. `test:packaged` repeats this against the
ASAR-packaged executable. Tests save screenshots and failure traces in `test-results/`. Linux CI uses Xvfb.

Local verification covers **macOS arm64**, including the packaged app. The
Windows x64 ZIP has been cross-built on macOS and its bundled runtime hashes checked, but has not been
launched on Windows in this local session. The
[`Electron desktop` workflow](../.github/workflows/electron.yml) builds and tests Windows x64, Linux x64,
macOS arm64, and macOS Intel on their respective runners. Those targets require passing CI and OS-level
release checks before support is advertised; the workflow has not been run from this local session.

## Layout and notices

- `src/main.cjs`: native dialogs, bounded file reads, application protocol, and IPC validation.
- `src/preload.cjs`: the narrow native bridge.
- `src/windows-install.cjs`: Windows installer lifecycle and shortcut handling.
- `src/renderer.mjs`: form, worker lifecycle, progress, paginated tables, and day selection.
- `src/timeseries.mjs` and `src/timeseries-plot.mjs`: bounded per-day CWA signal previews and SVG plotting.
- `src/worker.mjs`: local runtime initialization and fixed processing entry point.
- `src/cwa-import.mjs`: bounded packet decoding with the bundled Rust reader and channel/timestamp validation.
- `python/adapter.py`: recording validation, unit conversion, dataset construction, and result serialization.
- `scripts/prepare-runtime.mjs`: builds and bundles the wheel and dependency closure.
- `forge.config.cjs`: ASAR packaging and portable ZIP generation.

MobGap's Apache license and NOTICE are copied into each app. Python package license files remain in the bundled
wheels. `runtime/THIRD_PARTY_NOTICES.txt` includes their available notices and metadata, plus the Pyodide MPL
and CPython licenses in `licenses/`. Electron's own license and Chromium notices ship with the Electron bundle.
