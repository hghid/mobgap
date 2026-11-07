"""Generate independent native-reader arrays and pipeline tables for Wasm parity tests."""

import hashlib
import json
import struct
import sys
from datetime import datetime
from importlib.metadata import version
from pathlib import Path

import numpy as np

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root.parent))
# Optional isolated 0.5.0 oracle; otherwise compare with the repository's native 0.4.0 reader.
oracle = root / ".cache/cwa-native"
if oracle.exists():
    sys.path.insert(0, str(oracle))

import cwa_reader_rs as reader  # noqa: E402

from electron.python.adapter import calendar_days, process_cwa  # noqa: E402
from electron.tests.cwa_fixtures import create_cwa  # noqa: E402

output = root / ".cache/cwa-tests"
output.mkdir(parents=True, exist_ok=True)
manifest = {"reader_version": version("cwa-reader-rs"), "cases": []}
base = root.parent / "example_data"
options = {
    "sampling_rate_hz": 100,
    "acceleration_unit": "g",
    "height_m": 1.59,
    "sensor_height_m": 0.964,
    "cohort": "HA",
    "measurement_condition": "laboratory",
}
paths = [base / "data/ax6/example-610-steps.cwa"]
long_recording = create_cwa(
    base / "data_csv/HA/001/TimeMeasure1_Test11_Trial1.csv", output / "long-six-axis.cwa", repetitions=5
)
for cohort in ["HA", "MS"]:
    paths.append(
        create_cwa(base / f"data_csv/{cohort}/001/TimeMeasure1_Test11_Trial1.csv", output / f"{cohort}-six-axis.cwa")
    )
cases = [(source, rate) for source in paths for rate in [100, 60]]
cases.append((long_recording, 1000))
for source, rate in cases:
    name = f"{source.stem}-{rate}"
    data = reader.read_cwa_file(
        str(source),
        resample_hz=rate,
        resample_method="cubic",
        include_temperature=False,
        include_light=False,
        include_battery=False,
        include_magnetometer=False,
    )
    channels = {name.replace("gyro_", "gyr_"): values.to_numpy(dtype=np.float32) for name, values in data.items()}
    timestamps = data.index.as_unit("us").asi8
    case = {
        "name": name,
        "path": str(source),
        "rate": rate,
        "columns": list(channels),
        "samples": len(data),
        "timestamps_sha256": hashlib.sha256(timestamps.astype("<i8").tobytes()).hexdigest(),
    }
    for column, values in channels.items():
        values.astype("<f4").tofile(output / f"{name}-{column}.bin")
    if len(channels) == 6:
        run_options = {
            **options,
            "sampling_rate_hz": rate,
            "cohort": "MS" if source.stem.startswith("MS") else "HA",
        }
        result = process_cwa(source.read_bytes(), channels, timestamps, reader.read_metadata(str(source)), run_options)
        (output / f"{name}-results.json").write_text(json.dumps(result, allow_nan=False))
        case["options"] = run_options
    manifest["cases"].append(case)
midnight_source = create_cwa(
    base / "data_csv/HA/001/TimeMeasure1_Test11_Trial1.csv",
    output / "midnight-six-axis.cwa",
    epoch=datetime(2024, 1, 2, 23, 59, 30),
)
metadata = reader.read_metadata(str(midnight_source))
days = calendar_days(metadata["start_from_data_raw"], metadata["end_from_data_raw"], 100)
manifest["daily"] = {"path": str(midnight_source), "days": days, "options": options}
# A valid mixed-channel container verifies that a failed first day does not
# suppress an independently readable six-axis second day.
mixed = bytearray(midnight_source.read_bytes())
for offset in range(1024, 1024 + 75 * 512, 512):
    mixed[offset + 25] = 0x32
    checksum = -sum(struct.unpack("<255H", mixed[offset : offset + 510])) & 0xFFFF
    struct.pack_into("<H", mixed, offset + 510, checksum)
mixed_path = output / "failed-first-day.cwa"
mixed_path.write_bytes(mixed)
manifest["daily"]["failed_first_path"] = str(mixed_path)
for day in days:
    data = reader.read_cwa_file(
        str(midnight_source),
        cut=reader.seconds(day["start_s"], day["end_s"]),
        resample_hz=100,
        include_temperature=False,
        include_light=False,
        include_battery=False,
        include_magnetometer=False,
    )
    channels = {name.replace("gyro_", "gyr_"): values.to_numpy(dtype=np.float32) for name, values in data.items()}
    timestamps = data.index.as_unit("us").asi8
    result = process_cwa(midnight_source.read_bytes(), channels, timestamps, metadata, options)
    (output / f"day-{day['date']}-results.json").write_text(json.dumps(result, allow_nan=False))
    wear_result = process_cwa(
        midnight_source.read_bytes(),
        channels,
        timestamps,
        metadata,
        {"pipeline_type": "weartime", "sampling_rate_hz": 100, "acceleration_unit": "g"},
    )
    (output / f"day-{day['date']}-weartime-results.json").write_text(json.dumps(wear_result, allow_nan=False))
    day["samples"] = len(data)
    day["timestamps_sha256"] = hashlib.sha256(timestamps.astype("<i8").tobytes()).hexdigest()
(output / "native.json").write_text(json.dumps(manifest, allow_nan=False))
print(f"Generated {len(manifest['cases'])} native CWA comparisons.")
