"""Execute the supplied driver's single-day path through real MATLAB inputs for independent parity checks."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from scipy.io import savemat

DEFAULT_REFERENCE = Path(__file__).resolve().parents[1] / "tests/fixtures/driver_rev_single_day.py"


def reference_day(
    raw_g: pd.DataFrame,
    rate: float,
    options: dict[str, Any],
    date: str,
    folder: Path,
    reference: Path = DEFAULT_REFERENCE,
) -> dict[str, Any]:
    """Run unmodified ``run_day`` on CWA-derived Acc/Gyr arrays and centimetre-based infoForAlgo metadata.

    Only the configurable cohort and pipeline-class binding change between test cases. The factory records the
    actual default pipeline instance without replacing its implementation, making all six output tables available.
    Neither the desktop adapter nor its BAM setup is imported by this reference implementation.
    """
    folder.mkdir(parents=True, exist_ok=True)
    sensor = {
        "Acc": raw_g[[f"acc_{axis}" for axis in "xyz"]].to_numpy(dtype=np.float64),
        "Gyr": raw_g[[f"gyr_{axis}" for axis in "xyz"]].to_numpy(dtype=np.float64),
        "Fs": {"Acc": rate, "Gyr": rate},
    }
    savemat(folder / "data.mat", {"data": {"TimeMeasure1": {"Recording4": {"SU": {"LowerBack": sensor}}}}})
    del sensor
    savemat(
        folder / "infoForAlgo.mat",
        {
            "infoForAlgo": {
                "TimeMeasure1": {
                    "Height": options["height_m"] * 100,
                    "SensorHeight": options["sensor_height_m"] * 100,
                }
            }
        },
    )
    spec = importlib.util.spec_from_file_location("bam_reference_driver", reference)
    driver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(driver)
    if options["cohort"] != driver.COHORT:
        driver.COHORT = options["cohort"]
        driver.PIPELINE_CLASS = (
            driver.MobilisedPipelineHealthy
            if driver.COHORT in ("HA", "COPD", "CHF")
            else driver.MobilisedPipelineImpaired
        )
    actual_class = driver.PIPELINE_CLASS
    created = []

    def create_pipeline():
        instance = actual_class()
        created.append(instance)
        return instance

    driver.PIPELINE_CLASS = create_pipeline
    _, _, _, hours = driver.run_day("recording", "TimeMeasure1", date, str(folder))
    pipeline = created[0]
    tables = {}
    for name, attribute in {
        "aggregated": "aggregated_parameters_",
        "walking_bouts": "per_wb_parameters_",
        "strides": "per_stride_parameters_",
        "gait_sequences": "gs_list_",
        "initial_contacts": "raw_ic_list_",
        "walking_bout_mask": "per_wb_parameter_mask_",
    }.items():
        frame = getattr(pipeline, attribute)
        if frame is None:
            tables[name] = {"columns": [], "rows": []}
        else:
            value = json.loads(frame.reset_index().to_json(orient="split", index=False, double_precision=15))
            tables[name] = {"columns": value["columns"], "rows": value["data"]}
    return {
        "tables": tables,
        "pipeline": type(pipeline).__name__,
        "day_hours": hours,
        "parameters": repr(pipeline.get_params(deep=False)),
        "reference_file_sha256": hashlib.sha256(reference.read_bytes()).hexdigest(),
    }
