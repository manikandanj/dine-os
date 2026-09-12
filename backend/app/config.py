"""Only server-side configuration; dotenv is parsed as data, never executed."""
import os
from pathlib import Path
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[2]

def load_config():
    values = dotenv_values(ROOT / '.env')
    for key, value in values.items():
        if value is not None:
            os.environ.setdefault(key, value)

load_config()
