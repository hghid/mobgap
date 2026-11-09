# Author: Dr Cameron Kirk; original driver_rev.py revised 2026-11-03.
# Single-day excerpt, preserving the original configuration and run_day implementation.
# Multi-file scanning, private directory configuration, and weekly pooling are excluded.
# Original source SHA-256: c0c7d1274f43eb0024b5bfb84c80f515ee1257789826bddcfeaafabdd5fe7654

import os
from scipy.io import loadmat
from mobgap.data import load_mobilised_matlab_format
from mobgap.pipeline import MobilisedPipelineHealthy, MobilisedPipelineImpaired

COHORT = "PD"

PIPELINE_CLASS = MobilisedPipelineHealthy if COHORT in ("HA", "COPD", "CHF") else MobilisedPipelineImpaired

TIME_MEASURE = "TimeMeasure1"

TEST_NAME = "Recording4"

SENSOR = "LowerBack"

FLIP_AXES = ["acc_x", "acc_z", "gyr_x", "gyr_z"]

MIN_DAY_HOURS = 0.0


class MyLongTrial:
    """Minimal datapoint with the attributes the mobgap pipeline reads."""

    def __init__(self, data_ss, participant_metadata, recording_metadata, group_label, sampling_rate_hz):
        self.data_ss = data_ss
        self.participant_metadata = participant_metadata
        self.recording_metadata = recording_metadata
        self.group_label = group_label
        self.sampling_rate_hz = sampling_rate_hz

    @property
    def group(self):
        return self.group_label


def matstruct_to_dict(matstruct):
    return {field: getattr(matstruct, field) for field in matstruct._fieldnames}


def load_participant_metadata(info_path):
    info = loadmat(info_path, squeeze_me=True, struct_as_record=False)["infoForAlgo"]
    meta = matstruct_to_dict(getattr(info, TIME_MEASURE))
    for key in ("SensorHeight", "Height"):
        if key not in meta:
            raise KeyError(f"'{key}' missing from infoForAlgo.{TIME_MEASURE}")
    meta["sensor_height_m"] = float(meta.pop("SensorHeight")) / 100
    meta["height_m"] = float(meta.pop("Height")) / 100
    meta["cohort"] = COHORT
    return meta


def day_is_valid(imu_data, fs):
    hours = len(imu_data) / fs / 3600
    return hours >= MIN_DAY_HOURS, hours


def run_day(participant, time_point, day, day_folder):
    """Run the pipeline on one day. Returns (per_wb, per_wb_mask, daily_agg, day_hours)."""
    data_path = os.path.join(day_folder, "data.mat")
    info_path = os.path.join(day_folder, "infoForAlgo.mat")
    for p in (data_path, info_path):
        if not os.path.isfile(p):
            raise FileNotFoundError(f"missing {os.path.basename(p)}")

    participant_metadata = load_participant_metadata(info_path)
    recording_metadata = {
        "measurement_condition": "free_living",
        "test": TEST_NAME,
        "time_measure": TIME_MEASURE,
    }

    data = load_mobilised_matlab_format(data_path)
    recording = data[(TIME_MEASURE, TEST_NAME)]
    fs = float(recording.metadata["sampling_rate_hz"])
    imu_data = recording.imu_data[SENSOR].copy()

    for col in FLIP_AXES:
        imu_data[col] = -imu_data[col]

    valid, hours = day_is_valid(imu_data, fs)
    if not valid:
        raise ValueError(f"day too short ({hours:.1f} h < {MIN_DAY_HOURS} h)")

    long_trial = MyLongTrial(
        imu_data,
        participant_metadata,
        recording_metadata,
        group_label=(COHORT, participant, time_point, day),
        sampling_rate_hz=fs,
    )

    pipeline = PIPELINE_CLASS().safe_run(long_trial)  # fresh pipeline per day
    return pipeline.per_wb_parameters_, pipeline.per_wb_parameter_mask_, pipeline.aggregated_parameters_, hours
