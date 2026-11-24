"""Editable Mobilise-BAM daily pipeline based on driver_rev.py."""

from mobgap.data import GaitDatasetFromData
from mobgap.pipeline import MobilisedPipelineHealthy, MobilisedPipelineImpaired


def analyze_day(data, *, height_m, sensor_height_m, condition, sampling_rate_hz, cohort):
    """Process a recording mounted according to the BAM study's convention.

    Input channels are acc_x/y/z in m/s^2 and gyr_x/y/z in deg/s, sampled at
    sampling_rate_hz. Heights are in metres. The driver uses free_living.
    The app supplies the naive device-clock datetime in data.attrs. Output
    tables use day-relative indices and include the driver's threshold masks.
    """
    # Apply the driver's 180-degree rotation about sensor Y.
    axes = ["acc_x", "acc_z", "gyr_x", "gyr_z"]
    rotated = data.assign(**{axis: -data[axis] for axis in axes})
    start = data.attrs.get("first_sample_device_time")
    key = (cohort, "recording", "TimeMeasure1", start.date().isoformat() if start else "day")
    dataset = GaitDatasetFromData(
        {key: {"LowerBack": rotated}},
        sampling_rate_hz,
        {key: {"height_m": height_m, "sensor_height_m": sensor_height_m, "cohort": cohort}},
        {key: {"measurement_condition": condition, "test": "Recording4", "time_measure": "TimeMeasure1"}},
        index_cols=["cohort", "participant", "time_point", "day"],
    )
    pipeline_class = MobilisedPipelineHealthy if cohort in {"HA", "COPD", "CHF"} else MobilisedPipelineImpaired
    # Configure the selected pipeline before running it for this day.
    pipeline = pipeline_class()
    pipeline.safe_run(dataset)
    return {
        "aggregated": pipeline.aggregated_parameters_,
        "walking_bouts": pipeline.per_wb_parameters_,
        "strides": pipeline.per_stride_parameters_,
        "gait_sequences": pipeline.gs_list_,
        "initial_contacts": pipeline.raw_ic_list_,
        "walking_bout_mask": pipeline.per_wb_parameter_mask_,
    }
