#!/usr/bin/env python3
"""Check the registry, pinned provenance, native marketplace and vendored bytes."""
import argparse
import json
from pathlib import Path
import sys
from marketplace import MarketError, validate

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
parser.add_argument('--check', action='store_true', help='Explicit read-only validation (the default)')
args = parser.parse_args()
try:
    print(json.dumps(validate(args.root), ensure_ascii=False))
except (MarketError, OSError) as error:
    print('Validation failed: ' + str(error), file=sys.stderr)
    raise SystemExit(1)
