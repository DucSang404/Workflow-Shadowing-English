#!/bin/sh
# Starts the scene generator on the host. Needs `uv`; everything else is pulled
# on first run and cached (~3 GB of PyTorch, ~2.7 GB of model weights).
#
#   host/imagegen/run.sh          # foreground
#   host/imagegen/run.sh &        # background
#
# It must run HERE and not in docker compose: Docker Desktop on macOS cannot
# reach the Metal GPU, so a containerised model would fall back to CPU.
cd "$(dirname "$0")/../.." || exit 1
exec uv run --quiet host/imagegen/server.py
