#!/usr/bin/env python3
"""Mac: build a prepared QA overlay inside the shared build guard; no device work."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', required=True)
args = parser.parse_args()
if not os.environ.get('IOS_WORKLOAD_ACTIVE'): raise SystemExit('Use mac-workload build')
source = Path(args.source).resolve()
record = json.loads((source.parents[1] / 'qa-source.json').read_text())
if record.get('simulatorOnly') is not True: raise SystemExit('Not a prepared simulator-only QA source')
tools = Path.home() / 'Developer/ios-tools'
sys.path.insert(0, str(tools / 'push'))
from compilation_cache import build_environment
environment = build_environment(dict(os.environ, SIMULATOR='1'), source.parents[1] / 'metadata', source,
                                Path.home() / 'Library/Caches/ios-tools/CompilationCache.noindex')
config = Path(environment['XCODE_XCCONFIG_FILE'])
with config.open('a') as stream: stream.write('ARCHS = x86_64\nONLY_ACTIVE_ARCH = YES\n')
subprocess.run([sys.executable, 'scripts/build-guest.py', 'asura'], cwd=source, env=environment, check=True)
