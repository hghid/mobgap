import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from electron.python.adapter import CHANNELS, calendar_days, csv_days, load_csv, load_cwa, process_csv, process_csv_day
from mobgap.consts import GRAV_MS2

EXAMPLES = Path(__file__).resolve().parents[2] / "example_data/data_csv"


@pytest.fixture
def options():
    return {
        "sampling_rate_hz": 100,
        "acceleration_unit": "g",
        "height_m": 1.59,
        "sensor_height_m": 0.964,
        "cohort": "HA",
        "measurement_condition": "laboratory",
    }


@pytest.fixture
def frame():
    data = pd.DataFrame(np.zeros((1000, 6)), columns=CHANNELS)
    data.insert(0, "samples", np.arange(1000))
    return data


def csv_bytes(frame):
    return frame.to_csv(index=False).encode()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("sampling_rate_hz", 0),
        ("sampling_rate_hz", float("inf")),
        ("height_m", None),
        ("cohort", "unknown"),
        ("acceleration_unit", "unknown"),
        ("measurement_condition", "unknown"),
        ("sensor_height_m", 2),
    ],
)
def test_invalid_metadata_is_rejected(frame, options, field, value):
    with pytest.raises(ValueError):
        load_csv(csv_bytes(frame), {**options, field: value})


@pytest.mark.parametrize("issue", ["gap", "nonzero_start", "duplicate", "nan", "infinite", "text", "missing", "short"])
def test_invalid_recordings_are_rejected(frame, options, issue):
    if issue == "gap":
        frame.loc[500:, "samples"] += 1
    elif issue == "nonzero_start":
        frame["samples"] += 1
    elif issue == "duplicate":
        frame.loc[1, "samples"] = 0
    elif issue in {"nan", "infinite"}:
        frame.loc[0, "acc_x"] = np.nan if issue == "nan" else np.inf
    elif issue == "text":
        frame["acc_x"] = "invalid"
    elif issue == "missing":
        frame = frame.drop(columns="gyr_z")
    else:
        frame = frame.iloc[:10]
    with pytest.raises(ValueError):
        load_csv(csv_bytes(frame), options)


def test_acceleration_unit_conversion(options):
    data = (EXAMPLES / "HA/001/TimeMeasure1_Test11_Trial1.csv").read_bytes()
    original = pd.read_csv(EXAMPLES / "HA/001/TimeMeasure1_Test11_Trial1.csv")
    loaded = load_csv(data, options)
    np.testing.assert_allclose(loaded[CHANNELS[:3]], original[CHANNELS[:3]] * GRAV_MS2, rtol=0, atol=1e-14)
    np.testing.assert_array_equal(loaded[CHANNELS[3:]], original[CHANNELS[3:]])
    original.loc[:, CHANNELS[:3]] *= GRAV_MS2
    pd.testing.assert_frame_equal(
        loaded, load_csv(csv_bytes(original), {**options, "acceleration_unit": "m/s²"}), check_exact=False, atol=1e-14
    )


def test_recording_without_walking_has_valid_empty_tables(frame, options):
    frame["acc_x"] = 1.0
    stages = []
    result = process_csv(csv_bytes(frame), options, lambda stage, _message: stages.append(stage))
    assert stages == ["validate", "process", "tables"]
    assert result["tables"]["gait_sequences"]["rows"] == []
    assert result["tables"]["strides"]["rows"] == []
    assert result["provenance"]["samples"] == 1000
    assert len(result["provenance"]["input_sha256"]) == 64
    json.dumps(result, allow_nan=False)


def test_cwa_converts_float32_channels_without_losing_device_time_precision(frame, options):
    frame["acc_x"] = 1.0
    channels = {name: frame[name].to_numpy(dtype=np.float32) for name in CHANNELS}
    timestamps = np.arange(1000, dtype=np.int64) * 10_000 + 1_704_153_600_000_001
    expected = load_csv(csv_bytes(frame), options)
    pd.testing.assert_frame_equal(load_cwa(channels, timestamps, options), expected)


@pytest.mark.parametrize("issue", ["missing_gyro", "missing_samples", "nan", "time_gap", "time_order", "units"])
def test_cwa_rejects_incomplete_channels_or_inconsistent_timing(frame, options, issue):
    channels = {name: frame[name].to_numpy(dtype=np.float32).copy() for name in CHANNELS}
    timestamps = np.arange(1000, dtype=np.int64) * 10_000
    if issue == "missing_gyro":
        channels.pop("gyr_x")
    elif issue == "missing_samples":
        channels["acc_x"] = channels["acc_x"][:-1]
    elif issue == "nan":
        channels["acc_x"][0] = np.nan
    elif issue == "time_gap":
        timestamps[500:] += 10_000
    elif issue == "time_order":
        timestamps[1] = timestamps[0]
    else:
        options["acceleration_unit"] = "m/s²"
    with pytest.raises(ValueError):
        load_cwa(channels, timestamps, options)


@pytest.mark.parametrize("format_name", ["csv", "cwa"])
def test_large_recording_keeps_all_samples_and_final_measurement(options, format_name):
    count = 500_003
    channels = {name: np.zeros(count, dtype=np.float32) for name in CHANNELS}
    channels["acc_x"][:] = 1.0
    channels["gyr_z"][-1] = 123.25
    if format_name == "csv":
        frame = pd.DataFrame(channels)
        frame.insert(0, "samples", np.arange(count))
        loaded = load_csv(csv_bytes(frame), options)
    else:
        timestamps = 1_704_153_600_000_001 + np.arange(count, dtype=np.int64) * 10_000
        loaded = load_cwa(channels, timestamps, options)
    assert len(loaded) == count
    assert loaded.index[-1] == count - 1
    assert loaded["gyr_z"].iloc[-1] == 123.25


def test_midnight_windows_include_partial_edges_and_full_interior_day():
    days = calendar_days("2024-02-28T23:00:00", "2024-03-01T01:00:00", 100)
    assert [day["date"] for day in days] == ["2024-02-28", "2024-02-29", "2024-03-01"]
    assert days[0]["end_s"] == 3600
    assert days[1]["end_s"] - days[1]["start_s"] == 86400
    assert days[2]["start_time"] == "2024-03-01T00:00:00"
    assert days[2]["end_time"] == "2024-03-01T01:00:00.010000"


def test_csv_days_assign_midnight_samples_once_and_preserve_partial_days(frame, options):
    options["recording_start_time"] = "2024-01-02T23:59:50"
    frame = pd.concat([frame, frame], ignore_index=True)
    frame["samples"] = np.arange(len(frame))
    frame["acc_x"] = 1.0
    data = load_csv(csv_bytes(frame), options)
    days = csv_days(data, options)
    assert [(day["sample_start"], day["sample_end"]) for day in days] == [(0, 1000), (1000, 2000)]
    results = [process_csv_day(data, day, options, "0" * 64) for day in days]
    assert [result["provenance"]["samples"] for result in results] == [1000, 1000]
    assert all(result["provenance"]["input_sha256"] == "0" * 64 for result in results)


def test_tiny_first_boundary_day_is_reported_without_losing_the_next_day(frame, options):
    options["recording_start_time"] = "2024-01-02T23:59:59.500000"
    frame["acc_x"] = 1.0
    data = load_csv(csv_bytes(frame), options)
    days = csv_days(data, options)
    results = [process_csv_day(data, day, options, "0" * 64) for day in days]
    assert results[0]["status"] == "skipped"
    assert results[0]["provenance"]["samples"] == 50
    assert results[1]["provenance"]["samples"] == 950
    assert "status" not in results[1]
