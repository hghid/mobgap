"""Compare the desktop BAM configuration with the supplied driver's independent single-day execution."""

import ast
import io
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from electron.python.adapter import BAM_FLIP_AXES, csv_days, load_csv, process_csv, process_csv_day, validate_options
from electron.scripts.bam_reference import DEFAULT_REFERENCE, reference_day

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize(
    ("cohort", "example", "expected_class"),
    [
        ("PD", "MS", "MobilisedPipelineImpaired"),
        ("HA", "HA", "MobilisedPipelineHealthy"),
    ],
)
def test_bam_matches_actual_driver_day_and_exports_mask(tmp_path, cohort, example, expected_class):
    raw = pd.read_csv(ROOT / f"example_data/data_csv/{example}/001/TimeMeasure1_Test11_Trial1.csv")
    for column in BAM_FLIP_AXES:
        raw[column] *= -1
    raw = pd.read_csv(io.StringIO(raw.to_csv(index=False)))
    options = {
        "pipeline_type": "bam",
        "cohort": cohort,
        "sampling_rate_hz": 100,
        "acceleration_unit": "g",
        "height_m": 1.7,
        "sensor_height_m": 0.8,
        "measurement_condition": "free_living",
        "recording_start_time": "2024-01-02T12:00:00",
    }
    expected = reference_day(raw, 100, options, "2024-01-02", tmp_path)
    actual = process_csv(raw.to_csv(index=False).encode(), options)
    assert actual["provenance"]["pipeline"] == expected_class
    assert actual["provenance"]["bam_configuration"]["axis_flips"] == ["acc_x", "acc_z", "gyr_x", "gyr_z"]
    assert actual["provenance"]["bam_configuration"]["recording_metadata"] == {
        "measurement_condition": "free_living",
        "test": "Recording4",
        "time_measure": "TimeMeasure1",
    }
    assert actual["tables"]["walking_bouts"]["rows"]
    for key, table in expected["tables"].items():
        assert actual["tables"][key]["columns"] == table["columns"]
        a = pd.DataFrame(actual["tables"][key]["rows"], columns=table["columns"])
        b = pd.DataFrame(table["rows"], columns=table["columns"])
        pd.testing.assert_frame_equal(a, b, check_exact=False, rtol=1e-7, atol=1e-8)
    json.dumps(actual, allow_nan=False)


def test_bam_requires_driver_condition_and_keeps_daily_source_unchanged():
    options = {
        "pipeline_type": "bam",
        "cohort": "PD",
        "sampling_rate_hz": 100,
        "acceleration_unit": "g",
        "height_m": 1.7,
        "sensor_height_m": 0.8,
        "measurement_condition": "free_living",
        "recording_start_time": "2024-01-02T23:59:59.500000",
    }
    with pytest.raises(ValueError, match="free_living"):
        validate_options({**options, "measurement_condition": "laboratory"})
    with pytest.raises(ValueError, match="height_m"):
        validate_options({**options, "height_m": None})
    frame = pd.DataFrame({name: np.zeros(1000) for name in ["acc_x", "acc_y", "acc_z", "gyr_x", "gyr_y", "gyr_z"]})
    frame["acc_x"] = -1
    frame.insert(0, "samples", np.arange(1000))
    data = load_csv(frame.to_csv(index=False).encode(), options)
    original = data.copy(deep=True)
    results = [process_csv_day(data, day, options, "a" * 64) for day in csv_days(data, options)]
    assert results[0]["status"] == "skipped"
    assert "walking_bout_mask" in results[0]["tables"]
    assert results[1]["provenance"]["pipeline_type"] == "bam"
    pd.testing.assert_frame_equal(data, original)


def test_reference_excerpt_matches_supplied_single_day_source_when_available():
    original = ROOT / "electron/driver_rev.py"
    if not original.exists():
        pytest.skip("Optional original driver is local only; CI uses the checked-in single-day excerpt.")

    def nodes(path):
        return {
            node.name: ast.dump(node)
            for node in ast.parse(path.read_text()).body
            if isinstance(node, (ast.FunctionDef, ast.ClassDef))
        }

    supplied, snapshot = nodes(original), nodes(DEFAULT_REFERENCE)
    for name, definition in snapshot.items():
        assert supplied[name] == definition, name
