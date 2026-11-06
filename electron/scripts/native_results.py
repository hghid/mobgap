"""Run the desktop adapter under native CPython for the parity check."""

import importlib.util
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("desktop_adapter", root / "python/adapter.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
filename, options_json = sys.argv[1:]
result = adapter.process_csv(Path(filename).read_bytes(), json.loads(options_json))
print(json.dumps(result, allow_nan=False))
