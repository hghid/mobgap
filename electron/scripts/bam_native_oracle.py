"""Create independent driver_rev.py daily reference results; private input/output stays outside version control."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent))
oracle = ROOT / ".cache/cwa-native"
if oracle.exists():
    sys.path.insert(0, str(oracle))

import cwa_reader_rs as reader  # noqa: E402

from electron.python.adapter import calendar_days  # noqa: E402
from electron.scripts.bam_reference import DEFAULT_REFERENCE, reference_day  # noqa: E402
from electron.tests.cwa_fixtures import create_cwa  # noqa: E402


def main() -> None:
    """Generate synthetic midnight cases by default, or one selected day from an explicitly supplied real CWA."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--date")
    parser.add_argument("--height", type=float)
    parser.add_argument("--sensor-height", type=float)
    parser.add_argument("--cohort", default="PD", choices=["HA", "COPD", "CHF", "PD", "MS", "PFF"])
    parser.add_argument("--reference", type=Path, default=DEFAULT_REFERENCE)
    parser.add_argument("--max-seconds", type=float)
    args = parser.parse_args()
    if args.input and (args.height is None or args.sensor_height is None):
        parser.error("Real recordings require explicit --height and --sensor-height in metres.")
    if args.input and not 0 < args.sensor_height <= args.height <= 3:
        parser.error("Provide valid heights with 0 < sensor height <= participant height <= 3 metres.")
    if args.max_seconds is not None and args.max_seconds < 5:
        parser.error("--max-seconds must be at least 5.")
    output = ROOT / ".cache/bam-tests" / ("private" if args.input else "synthetic")
    output.mkdir(parents=True, exist_ok=True)
    sources = []
    if args.input:
        sources.append((args.input, args.cohort, [100]))
    else:
        for cohort, example in [("PD", "MS"), ("HA", "HA")]:
            path = create_cwa(
                ROOT.parent / f"example_data/data_csv/{example}/001/TimeMeasure1_Test11_Trial1.csv",
                output / f"{cohort}-bam.cwa",
                flip_xz=True,
                epoch=datetime(2024, 1, 2, 23, 59, 30),
            )
            sources.append((path, cohort, [100, 60]))
    cases = []
    for source, cohort, rates in sources:
        metadata = reader.read_metadata(str(source))
        days = calendar_days(metadata["start_from_data_raw"], metadata["end_from_data_raw"], metadata["sample_rate_hz"])
        if args.input:
            selected = next((day for day in days if day["date"] == args.date), None) if args.date else days[0]
            if selected is None:
                parser.error("The selected date is outside the recording.")
            days = [selected]
        digest = hashlib.sha256()
        with source.open("rb") as handle:
            for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
                digest.update(chunk)
        for rate in rates:
            for day in days:
                end = min(day["end_s"], day["start_s"] + args.max_seconds) if args.max_seconds else day["end_s"]
                cut = {"type": "seconds", "start": day["start_s"], "end": end}
                name = f"{cohort}-{rate}-{day['date']}"
                print(
                    f"Native driver reference: {day['date']}, {cohort}, {rate} Hz, {(end - day['start_s']) / 3600:.2f} h",
                    flush=True,
                )
                started = time.perf_counter()
                data = reader.read_cwa_file(
                    str(source),
                    cut=reader.seconds(cut["start"], cut["end"]),
                    resample_hz=rate,
                    resample_method="cubic",
                    include_temperature=False,
                    include_light=False,
                    include_battery=False,
                    include_magnetometer=False,
                )
                data = data.rename(columns=lambda column: column.replace("gyro_", "gyr_"))
                timestamps = data.index.as_unit("us").asi8
                options = {
                    "pipeline_type": "bam",
                    "cohort": cohort,
                    "height_m": args.height if args.height is not None else 1.7,
                    "sensor_height_m": args.sensor_height if args.sensor_height is not None else 0.8,
                    "sampling_rate_hz": rate,
                    "acceleration_unit": "g",
                    "measurement_condition": "free_living",
                }
                for column in data:
                    data[column].to_numpy(dtype="<f4").tofile(output / f"{name}-{column}.bin")
                result = reference_day(data, rate, options, day["date"], output / f"{name}-mat", args.reference)
                expected_path = output / f"{name}-reference.json"
                expected_path.write_text(json.dumps(result, allow_nan=False))
                cases.append(
                    {
                        "name": name,
                        "path": str(source.resolve()),
                        "rate": rate,
                        "day": day,
                        "cut": cut,
                        "options": options,
                        "expected": str(expected_path),
                        "samples": len(data),
                        "input_sha256": digest.hexdigest(),
                        "timestamps_sha256": hashlib.sha256(timestamps.astype("<i8").tobytes()).hexdigest(),
                    }
                )
                print(
                    f"  Native reference finished: {len(data):,} samples, {len(result['tables']['walking_bouts']['rows'])} walking bouts, {time.perf_counter() - started:.1f}s",
                    flush=True,
                )
    (output / "manifest.json").write_text(json.dumps({"cases": cases}, indent=2))


if __name__ == "__main__":
    main()
