"""Validate one recording and run the unchanged preconfigured Mobilise-D pipeline.

The app supplies sensor-frame acceleration in explicitly selected units, gyroscope
data in degrees/second, and participant/recording metadata. Samples must be a
contiguous zero-based sequence; arbitrary sensor mounting is not corrected here.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import time
import warnings
from datetime import datetime, timedelta
from decimal import ROUND_CEILING, Decimal
from importlib.metadata import PackageNotFoundError, distributions, version
from typing import TYPE_CHECKING, Any

import numpy as np
import pandas as pd
from packaging.requirements import Requirement

from mobgap.consts import GRAV_MS2
from mobgap.data import GaitDatasetFromData
from mobgap.pipeline import MobilisedPipelineUniversal

if TYPE_CHECKING:
    from collections.abc import Callable

CHANNELS = ["acc_x", "acc_y", "acc_z", "gyr_x", "gyr_y", "gyr_z"]
COHORTS = {"HA", "COPD", "CHF", "MS", "PD", "PFF"}
RUNTIME_NOTICES = []


def calendar_days(start_time: str, last_time: str, sampling_rate_hz: float) -> list[dict[str, Any]]:
    """Plan half-open device-clock calendar days, retaining microsecond precision.

    First/last windows follow the recording bounds; all interior windows run
    midnight to midnight. Device time is naive: no host timezone or DST is inferred.
    """
    start = datetime.fromisoformat(start_time)
    last = datetime.fromisoformat(last_time)
    if start.tzinfo is not None or last.tzinfo is not None or last < start:
        raise ValueError("Provide ordered, timezone-free device-clock recording times.")
    end = last + timedelta(seconds=1 / sampling_rate_hz)
    cursor = start
    windows = []
    while cursor < end:
        boundary = cursor.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
        stop = min(boundary, end)
        windows.append(
            {
                "date": cursor.date().isoformat(),
                "start_time": cursor.isoformat(),
                "end_time": stop.isoformat(),
                "start_s": (cursor - start).total_seconds(),
                "end_s": (stop - start).total_seconds(),
            }
        )
        cursor = stop
    return windows


def csv_days(data: pd.DataFrame, options: dict[str, Any]) -> list[dict[str, Any]]:
    """Assign every CSV sample exactly once to midnight windows using the supplied start time."""
    start_text = options.get("recording_start_time")
    if not start_text:
        raise ValueError("Enter the CSV recording start date and time to split at midnight.")
    start = datetime.fromisoformat(start_text)
    rate = options["sampling_rate_hz"]
    last = start + timedelta(seconds=(len(data) - 1) / rate)
    days = calendar_days(start_text, last.isoformat(), rate)
    for day in days:
        for edge in ("start", "end"):
            # Decimal avoids moving an exact midnight sample to the wrong day
            # because of binary floating-point multiplication at long offsets.
            offset = Decimal(str(day[f"{edge}_s"])) * Decimal(str(rate))
            day[f"sample_{edge}"] = min(len(data), int(offset.to_integral_value(rounding=ROUND_CEILING)))
    days[-1]["sample_end"] = len(data)
    return days


def short_day_result(samples: int, options: dict[str, Any], digest: str, input_format: str) -> dict[str, Any]:
    """Report a very short boundary day explicitly without inventing algorithm outputs."""
    return {
        "schema_version": 1,
        "status": "skipped",
        "tables": {
            name: {"columns": [], "rows": []}
            for name in ["aggregated", "walking_bouts", "strides", "gait_sequences", "initial_contacts"]
        },
        "warnings": ["This boundary day contains fewer than 5 seconds of data; the pipeline was not run."],
        "provenance": {
            "input_sha256": digest,
            "input_format": input_format,
            "options": options,
            "samples": samples,
            "duration_s": samples / options["sampling_rate_hz"],
            "elapsed_s": 0,
            "pipeline": "Not run (short boundary day)",
        },
    }


def process_csv_day(
    data: pd.DataFrame,
    day: dict[str, Any],
    options: dict[str, Any],
    digest: str,
    progress: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """Run a fresh pipeline on one calendar-day CSV slice with day-relative sample indices."""
    daily = data.iloc[day["sample_start"] : day["sample_end"]].reset_index(drop=True).rename_axis("samples")
    if len(daily) < math.ceil(5 * options["sampling_rate_hz"]):
        return short_day_result(len(daily), options, digest, "csv")
    return _process_data(
        daily,
        None,
        options,
        progress or (lambda _stage, _message: None),
        time.perf_counter(),
        input_format="csv",
        input_sha256=digest,
    )


def validate_runtime() -> None:
    """Check installed wheel metadata against the frozen runtime, including markers."""
    issues = []
    for distribution in distributions():
        for text in distribution.requires or []:
            requirement = Requirement(text)
            if requirement.marker and not requirement.marker.evaluate({"extra": ""}):
                continue
            try:
                installed = version(requirement.name)
            except PackageNotFoundError:
                issues.append(f"{distribution.name} requires missing package {requirement}.")
                continue
            if not requirement.specifier.contains(installed, prereleases=True):
                issues.append(f"{distribution.name} requires {requirement}, but {installed} is installed.")
    if issues:
        raise RuntimeError("Incompatible desktop runtime: " + " ".join(issues))


def validate_options(options: dict[str, Any]) -> None:
    """Reject incomplete metadata instead of guessing physiological inputs."""
    for name, upper in [("sampling_rate_hz", 1000), ("height_m", 3), ("sensor_height_m", 3)]:
        value = options.get(name)
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or not 0 < value <= upper
        ):
            raise ValueError(f"Provide a valid {name} greater than zero and at most {upper}.")
    if options["sensor_height_m"] > options["height_m"]:
        raise ValueError("Sensor height cannot exceed participant height.")
    if options.get("cohort") not in COHORTS:
        raise ValueError("Select a supported cohort (HA, COPD, CHF, MS, PD, PFF).")
    if options.get("acceleration_unit") not in {"g", "m/s²"}:
        raise ValueError("Select acceleration units explicitly.")
    if options.get("measurement_condition") not in {"laboratory", "free_living"}:
        raise ValueError("Select laboratory or free-living measurement conditions.")


def load_csv(csv_bytes: bytes, options: dict[str, Any]) -> pd.DataFrame:
    """Load example-format CSV bytes, enforcing channel and sample contracts."""
    validate_options(options)
    frame = pd.read_csv(io.BytesIO(csv_bytes))
    missing = {*CHANNELS, "samples"} - set(frame.columns)
    if missing:
        raise ValueError(f"Missing CSV columns: {', '.join(sorted(missing))}.")
    if len(frame) < math.ceil(5 * options["sampling_rate_hz"]):
        raise ValueError("Provide at least 5 seconds of data for the preconfigured pipeline.")
    try:
        data = frame[CHANNELS].astype(np.float64)
        samples = pd.to_numeric(frame["samples"], errors="raise").to_numpy()
    except (ValueError, TypeError) as exc:
        raise ValueError("CSV samples and sensor channels must contain numeric values.") from exc
    if not np.array_equal(samples, np.arange(len(frame))):
        raise ValueError("The samples column must be contiguous integers starting at zero (no gaps or duplicates).")
    if not np.isfinite(data.to_numpy()).all():
        raise ValueError("Sensor channels contain missing or infinite values. Clean the recording before processing.")
    if options["acceleration_unit"] == "g":
        data.loc[:, CHANNELS[:3]] *= GRAV_MS2
    data.index = pd.RangeIndex(len(data), name="samples")
    return data


def table(frame: pd.DataFrame | None) -> dict[str, Any]:
    """Retain index columns, full numeric precision, and nulls across the JS boundary."""
    if frame is None:
        return {"columns": [], "rows": []}
    return json.loads(frame.reset_index().to_json(orient="split", index=False, double_precision=15))


def load_cwa(channels: dict[str, Any], timestamps_us: Any, options: dict[str, Any]) -> pd.DataFrame:
    """Convert the Rust reader's g/deg-s float32 columns to the pipeline's float64 sensor frame.

    Timestamps are exact signed microseconds on the naive device clock. The Rust
    reader resamples using cubic interpolation; this boundary verifies that its
    output follows the requested uniform grid without inferring a timezone.
    """
    validate_options(options)
    if options["acceleration_unit"] != "g":
        raise ValueError("CWA acceleration is decoded in g; do not override its units.")
    missing = set(CHANNELS) - set(channels)
    if missing:
        raise ValueError(f"CWA is missing required IMU channels: {', '.join(sorted(missing))}.")
    timestamps = np.asarray(timestamps_us, dtype=np.int64)
    if timestamps.ndim != 1 or len(timestamps) < math.ceil(5 * options["sampling_rate_hz"]):
        raise ValueError("CWA output must contain at least 5 seconds of samples.")
    expected = np.arange(len(timestamps), dtype=np.float64) * (1_000_000 / options["sampling_rate_hz"])
    if np.any(np.diff(timestamps) <= 0) or np.any(np.abs((timestamps - timestamps[0]) - expected) > 2):
        raise ValueError("CWA timestamps do not follow the requested uniform sampling grid.")
    values = {}
    for name in CHANNELS:
        column = np.asarray(channels[name], dtype=np.float64)
        if column.ndim != 1 or len(column) != len(timestamps) or not np.isfinite(column).all():
            raise ValueError(f"CWA channel {name} has invalid or missing samples.")
        values[name] = column * GRAV_MS2 if name.startswith("acc_") else column
    return pd.DataFrame(values, index=pd.RangeIndex(len(timestamps), name="samples"))


def process_cwa(
    original_bytes: bytes | None,
    channels: dict[str, Any],
    timestamps_us: Any,
    header: dict[str, Any],
    options: dict[str, Any],
    *,
    progress: Callable[[str, str], None] | None = None,
    input_sha256: str | None = None,
) -> dict[str, Any]:
    """Run a decoded CWA with the same pipeline and export schema as CSV input."""
    report = progress or (lambda _stage, _message: None)
    started = time.perf_counter()
    report("validate", "Validating decoded CWA and participant metadata…")
    data = load_cwa(channels, timestamps_us, options)
    timestamps = np.asarray(timestamps_us, dtype=np.int64)
    return _process_data(
        data,
        original_bytes,
        options,
        report,
        started,
        input_format="cwa",
        input_sha256=input_sha256,
        source={
            "header": header,
            "resample_method": "cubic",
            "first_sample_device_time_us": str(int(timestamps[0])),
            "last_sample_device_time_us": str(int(timestamps[-1])),
            "time_basis": "Naive device clock; no timezone or UTC offset inferred",
            "decoded_acceleration_unit": "g",
            "decoded_gyroscope_unit": "deg/s",
        },
    )


def process_csv(
    csv_bytes: bytes, options: dict[str, Any], progress: Callable[[str, str], None] | None = None
) -> dict[str, Any]:
    """Return result tables and reproducibility metadata for one recording.

    Progress reports completed stages. The pipeline computation is a single
    indeterminate stage; percentages do not estimate internal algorithm progress.
    """
    report = progress or (lambda _stage, _message: None)
    started = time.perf_counter()
    report("validate", "Validating CSV and participant metadata…")
    data = load_csv(csv_bytes, options)
    return _process_data(data, csv_bytes, options, report, started, input_format="csv")


def _process_data(
    data: pd.DataFrame,
    original_bytes: bytes | None,
    options: dict[str, Any],
    report: Callable[[str, str], None],
    started: float,
    *,
    input_format: str,
    source: dict[str, Any] | None = None,
    input_sha256: str | None = None,
) -> dict[str, Any]:
    key = "recording"
    participant = {name: options[name] for name in ["cohort", "height_m", "sensor_height_m"]}
    dataset = GaitDatasetFromData(
        {key: {"LowerBack": data}},
        options["sampling_rate_hz"],
        {key: participant},
        {key: {"measurement_condition": options["measurement_condition"]}},
    )
    report("process", "Running the preconfigured Mobilise-D pipeline…")
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        pipeline = MobilisedPipelineUniversal().safe_run(dataset)
    report("tables", "Preparing result tables…")
    results = {
        "aggregated": table(pipeline.aggregated_parameters_),
        "walking_bouts": table(pipeline.per_wb_parameters_),
        "strides": table(pipeline.per_stride_parameters_),
        "gait_sequences": table(pipeline.gs_list_),
        "initial_contacts": table(pipeline.raw_ic_list_),
    }
    # pandas split uses "data"; name rows consistently in the message contract.
    for value in results.values():
        if "data" in value:
            value["rows"] = value.pop("data")
    return {
        "schema_version": 1,
        "tables": results,
        "warnings": list(dict.fromkeys([*RUNTIME_NOTICES, *(str(item.message) for item in captured)])),
        "provenance": {
            "pipeline": type(pipeline.pipeline_).__name__,
            "parameters": repr(pipeline.pipeline_.get_params(deep=False)),
            "options": options,
            "input_sha256": input_sha256 if input_sha256 is not None else hashlib.sha256(original_bytes).hexdigest(),
            "input_format": input_format,
            "source": source,
            "samples": len(data),
            "duration_s": len(data) / options["sampling_rate_hz"],
            "elapsed_s": time.perf_counter() - started,
            "versions": {
                name: version(name) for name in ["mobgap", "numpy", "pandas", "scipy", "scikit-learn", "tpcp"]
            },
            "sensor_frame": "Mobilise-D aligned lower-back sensor; gyroscope in deg/s",
        },
    }
