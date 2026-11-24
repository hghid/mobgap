"""Editable daily analysis for MobGap Desktop (script API version 1).

The app loads this file once per Run, then calls analyze_day for each calendar
day containing at least five seconds of data. Instantiate algorithms inside
the function so their results belong to that day. Use packages bundled with
the desktop runtime. Save As creates a Python file you can share or reopen.
"""

from mobgap.data import GaitDatasetFromData
from mobgap.pipeline import MobilisedPipelineImpaired


def analyze_day(data, *, height_m, sensor_height_m, condition, sampling_rate_hz, cohort):
    """Run the standard impaired pipeline on one aligned lower-back recording.

    data is a pandas DataFrame in sensor coordinates. acc_x, acc_y and acc_z
    are in m/s² (including gravity); gyr_x, gyr_y and gyr_z are in degrees/s.
    The zero-based samples index and event positions are relative to this day.
    The app has already applied the chosen acceleration-unit conversion and,
    for CWA, resampled to sampling_rate_hz. This template expects aligned axes.
    Apply any study-specific orientation correction here before building the dataset.

    height_m and sensor_height_m are participant and device heights in metres.
    condition is "laboratory" or "free_living". cohort is the selected MobGap
    cohort code, used for DMO thresholds. MS, PD and PFF are the recommended
    cohorts for this pipeline. sampling_rate_hz is samples per second.

    Return a nonempty dict of table names to pandas DataFrames. Use lowercase
    letters and underscores for names (up to 40 characters). The app retains
    index levels as columns. Use unique string column names and reserve "day"
    for the combined view. Each table gets a tab and can be exported as CSV.
    """
    key = "recording"
    dataset = GaitDatasetFromData(
        {key: {"LowerBack": data}},
        sampling_rate_hz,
        {key: {"height_m": height_m, "sensor_height_m": sensor_height_m, "cohort": cohort}},
        {key: {"measurement_condition": condition}},
    )
    pipeline = MobilisedPipelineImpaired()
    # Customize component parameters here, before safe_run. For example:
    # pipeline.set_params(cadence_calculation__max_interpolation_gap_s=2)
    pipeline.safe_run(dataset)

    # Add a derived DataFrame here, or return only the tables your study uses.
    return {
        "aggregated": pipeline.aggregated_parameters_,
        "walking_bouts": pipeline.per_wb_parameters_,
        "strides": pipeline.per_stride_parameters_,
        "gait_sequences": pipeline.gs_list_,
        "initial_contacts": pipeline.raw_ic_list_,
    }
