"""Editable signal-based wear-time analysis for a single device-clock day."""

from datetime import timedelta
from decimal import ROUND_CEILING, Decimal

import pandas as pd

from mobgap.utils.conversions import to_body_frame
from mobgap.weartime import WtdMegaritisSignal


def analyze_day(data, *, height_m, sensor_height_m, condition, sampling_rate_hz, cohort):
    """Run the wear detector and calculate daily and waking-hour summaries.

    Input is an aligned six-axis sensor-frame DataFrame in m/s^2 and deg/s.
    sampling_rate_hz must be at least 50. Participant arguments are None in
    Weartime mode. data.attrs["first_sample_device_time"] is a timezone-free
    datetime on the device clock. Intervals are day-relative and end-exclusive.
    """
    start_time = data.attrs.get("first_sample_device_time")
    if start_time is None or start_time.tzinfo is not None:
        raise ValueError("Weartime requires a timezone-free device-clock start time.")
    rate = sampling_rate_hz
    if (start_time + timedelta(seconds=(len(data) - 1) / rate)).date() != start_time.date():
        raise ValueError("Run Weartime separately for each calendar day.")
    # Customize detection parameters or the waking-hours window here.
    detector = WtdMegaritisSignal().detect(to_body_frame(data), sampling_rate_hz=rate)

    # Clip the detector's waking window to the available samples on partial days.
    intervals = detector.weartime_list_.copy()
    midnight = start_time.replace(hour=0, minute=0, second=0, microsecond=0)
    bounds = []
    for boundary in detector.waking_hours:
        clock = midnight.replace(
            hour=boundary.hour, minute=boundary.minute, second=boundary.second, microsecond=boundary.microsecond
        )
        offset = Decimal(str((clock - start_time).total_seconds())) * Decimal(str(rate))
        bounds.append(max(0, min(len(data), int(offset.to_integral_value(rounding=ROUND_CEILING)))))
    waking_samples = (
        (intervals["end"].clip(upper=bounds[1]) - intervals["start"].clip(lower=bounds[0])).clip(lower=0).sum()
    )
    intervals["start_time"] = [
        (start_time + timedelta(seconds=int(sample) / rate)).isoformat() for sample in intervals["start"]
    ]
    intervals["end_time"] = [
        (start_time + timedelta(seconds=int(sample) / rate)).isoformat() for sample in intervals["end"]
    ]
    intervals["duration_min"] = (intervals["end"] - intervals["start"]) / (60 * rate)
    summary = pd.DataFrame(
        [
            {
                "total_weartime_min": detector.total_weartime_min_,
                "total_weartime_during_waking_min": float(waking_samples) / (60 * rate),
                "nonwear_min": len(data) / (60 * rate) - detector.total_weartime_min_,
                "recording_duration_min": len(data) / (60 * rate),
                "wear_fraction": detector.total_weartime_samples_ / len(data),
            }
        ]
    ).rename_axis("summary_id")
    return {
        "weartime_summary": summary,
        "weartime": intervals,
        "weartime_diagnostics": detector.diagnostics_["macro"].rename_axis("window_id"),
    }
