"""Editable Mobilise-D pipeline. The selected cohort determines the gait algorithms."""

from mobgap.data import GaitDatasetFromData
from mobgap.pipeline import MobilisedPipelineHealthy, MobilisedPipelineImpaired


def analyze_day(data, *, height_m, sensor_height_m, condition, sampling_rate_hz, cohort):
    """Process one day of aligned lower-back IMU data.

    The six sensor-frame channels are acc_x/y/z in m/s^2 and gyr_x/y/z in deg/s.
    The input index and output event positions are relative to this day.
    Heights are in metres, condition is laboratory or free_living, and
    sampling_rate_hz is the rate after decoding and resampling. Return a dict
    of named pandas DataFrames, using unique string columns and reserving "day"
    for the app's combined view. None represents an unavailable table.
    """
    key = "recording"
    dataset = GaitDatasetFromData(
        {key: {"LowerBack": data}},
        sampling_rate_hz,
        {key: {"height_m": height_m, "sensor_height_m": sensor_height_m, "cohort": cohort}},
        {key: {"measurement_condition": condition}},
    )
    # Use the recommended cohort-specific configuration. Edit its parameters here.
    pipeline_class = MobilisedPipelineHealthy if cohort in {"HA", "COPD", "CHF"} else MobilisedPipelineImpaired
    pipeline = pipeline_class()
    pipeline.safe_run(dataset)
    return {
        "aggregated": pipeline.aggregated_parameters_,
        "walking_bouts": pipeline.per_wb_parameters_,
        "strides": pipeline.per_stride_parameters_,
        "gait_sequences": pipeline.gs_list_,
        "initial_contacts": pipeline.raw_ic_list_,
    }
