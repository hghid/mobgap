"""Keep native Numba acceleration and run identical kernels in Pyodide without LLVM.

Only Emscripten uses the serial backend. Native installations still require Numba;
an import failure there is not silently treated as permission to change backends.
"""

from __future__ import annotations

import sys
from functools import wraps
from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    from collections.abc import Callable

IS_WASM = sys.platform == "emscripten"

__all__ = ["interval_list", "jit", "njit", "peak_count"]


def _serial_jit(function: Callable | None = None, **_options: Any) -> Callable:
    return function if function is not None else lambda func: func


def _serial_peak_count(function: Callable) -> Callable:
    """Apply the ILUZ scalar-output kernel rowwise using its original float32 inputs."""

    @wraps(function)
    def run(signal: np.ndarray, threshold: float, distance: float, output: np.ndarray) -> None:
        signal = np.asarray(signal, dtype=np.float64)
        threshold = np.float32(threshold)
        distance = np.float32(distance)
        for row, target in zip(signal, output.reshape(-1, 1)):
            function(row, threshold, distance, target)

    return run


if IS_WASM:
    njit = jit = _serial_jit
    interval_list = list
    peak_count = _serial_peak_count
else:
    from numba import float32, float64, guvectorize, int32, jit, njit
    from numba.typed import List

    interval_list = List

    def peak_count(function: Callable) -> Callable:
        """Compile the original ILUZ gufunc signature on native Python."""
        return guvectorize([(float64[:], float32, float32, int32[:])], "(n),(),()->()", target="parallel", cache=True)(
            function
        )
