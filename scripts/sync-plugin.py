#!/usr/bin/env python3
"""Synchronize reviewed, pinned plugin resources into the native marketplace."""
import argparse
import json
from pathlib import Path
import sys
from marketplace import MarketError, sync

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
parser.add_argument('--plugin', help='One registry identifier; omit to synchronize all entries')
parser.add_argument('--source-dir', type=Path, help='Offline source plugin directory; requires an existing matching source lock')
args = parser.parse_args()
try:
    print(json.dumps(sync(args.root, args.plugin, args.source_dir), ensure_ascii=False))
except (MarketError, OSError) as error:
    print('Synchronization failed: ' + str(error), file=sys.stderr)
    raise SystemExit(1)
