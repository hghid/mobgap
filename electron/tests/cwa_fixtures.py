"""Encode deterministic six-axis test packets; no private CWA recordings are distributed.

The layout follows Open Movement's 512-byte AX packet format. Signal values
come from the repository CSVs and are quantized to signed 16-bit gyro/accel
measurements. These are synthetic test containers, not real device exports.
"""

from __future__ import annotations

import struct
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

import numpy as np
import pandas as pd

if TYPE_CHECKING:
    from pathlib import Path


def packed_time(value: datetime) -> int:
    """Encode the CWA bitfield for a naive device-clock second."""
    return (
        ((value.year - 2000) << 26)
        | (value.month << 22)
        | (value.day << 17)
        | (value.hour << 12)
        | (value.minute << 6)
        | value.second
    )


def create_cwa(
    csv_path: Path, destination: Path, axes: int = 6, repetitions: int = 1, *, epoch: datetime | None = None
) -> Path:
    """Wrap example sensor samples in checksummed AX6 packets at 100 Hz."""
    frame = pd.read_csv(csv_path)
    if repetitions != 1:
        frame = pd.concat([frame] * repetitions, ignore_index=True)
    acceleration = np.rint(frame[[f"acc_{axis}" for axis in "xyz"]].to_numpy() * 4096)
    gyro = np.rint(frame[[f"gyr_{axis}" for axis in "xyz"]].to_numpy() * (32768 / 2000))
    values = np.column_stack([gyro, acceleration]) if axes == 6 else acceleration
    if np.any(np.abs(values) > 32767):
        raise ValueError("Fixture exceeds the selected sensor range.")
    values = values.astype("<i2")
    epoch = epoch or datetime(2024, 1, 2)
    header = bytearray(1024)
    header[:2] = b"MD"
    struct.pack_into("<H", header, 2, 1020)
    header[4] = 0x64
    struct.pack_into("<H", header, 5, 1234)
    struct.pack_into("<I", header, 13, packed_time(epoch))
    struct.pack_into("<I", header, 17, packed_time(epoch + timedelta(seconds=len(frame) // 100)))
    header[35] = 2
    header[36] = 0x4A
    struct.pack_into("<I", header, 37, packed_time(epoch))
    annotation = b"Synthetic MobGap importer test; no device identity"
    header[64 : 64 + len(annotation)] = annotation
    output = bytearray(header)
    per_packet = 480 // (axes * 2)
    for sequence, start in enumerate(range(0, len(values), per_packet)):
        samples = values[start : start + per_packet]
        packet = bytearray(512)
        packet[:2] = b"AX"
        struct.pack_into("<HHII", packet, 2, 508, 1234, 0, sequence)
        struct.pack_into("<I", packet, 14, packed_time(epoch + timedelta(seconds=start // 100)))
        struct.pack_into("<H", packet, 18, (4 << 13) | (2 << 10))
        packet[24] = 0x4A
        packet[25] = (axes << 4) | 2
        struct.pack_into("<hH", packet, 26, -(start % 100), len(samples))
        raw = samples.tobytes()
        packet[30 : 30 + len(raw)] = raw
        struct.pack_into("<H", packet, 510, -sum(struct.unpack("<255H", packet[:510])) & 0xFFFF)
        output.extend(packet)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(output)
    return destination
