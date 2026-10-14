#!/usr/bin/env bash
# Quick launcher for VForce RC Base Station

# Find suitable python in venv or venv_linux
if [ -f "venv_linux/bin/python3" ]; then
    PYTHON_BIN="venv_linux/bin/python3"
elif [ -f "venv/bin/python3" ]; then
    PYTHON_BIN="venv/bin/python3"
else
    PYTHON_BIN="python3"
fi

echo "Launching VForce RC Base Station using $PYTHON_BIN ..."
exec "$PYTHON_BIN" main.py "$@"
