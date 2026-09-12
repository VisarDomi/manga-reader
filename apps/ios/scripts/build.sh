#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Provider is mandatory, including for native GUI signing jobs.
exec /usr/bin/python3 scripts/build-guest.py "$@"
