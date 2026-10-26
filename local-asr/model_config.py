"""Offline model resolution: never downloads during application execution."""
import os
from pathlib import Path

def model_path():
    path = Path(os.environ.get('YANYU_MODEL_DIR', str(Path(__file__).resolve().parents[1] / 'models' / 'faster-whisper-small'))).expanduser().resolve()
    if not path.is_dir() or not (path / 'model.bin').is_file():
        raise ValueError('Local model missing. Set YANYU_MODEL_DIR to a faster-whisper-small snapshot containing model.bin; see README.md')
    return path
