#!/bin/sh
set -eu

# Claim the process fence before schema writers. The claim remains after a killed
# baseline or a later unsignalled crash. Never inherit a nonce from configuration.
runtime_control_dir="${FCM_RUNTIME_CONTROL_DIR:-/app/runtime-control}"
export FCM_RUNTIME_CONTROL_DIR="$runtime_control_dir"
unset FCM_RUNTIME_BOOT_NONCE
set -- "$runtime_control_dir"/restart-*.json
if [ -e "$runtime_control_dir/maintenance.json" ] || [ -L "$runtime_control_dir/maintenance.json" ] || [ -s "$runtime_control_dir/failures.jsonl" ] || [ -e "$1" ] || [ -L "$1" ]; then
  printf '%s\n' 'Frozen startup: skipping baseline migrations'
else
  FCM_RUNTIME_BOOT_NONCE="$(node dist/runtime/bootstrap.js "$$")"
  export FCM_RUNTIME_BOOT_NONCE
  if [ -n "$FCM_RUNTIME_BOOT_NONCE" ]; then
    ./baseline-migrations.sh
  else
    printf '%s\n' 'Frozen startup: process fence was already claimed'
  fi
fi

# Node becomes PID 1 and receives Docker SIGTERM/SIGINT directly.
exec node dist/server.js
