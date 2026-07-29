#!/bin/sh
# Minimal mock Grok CLI for manual/integration tests.
# Emits streaming-json and optionally writes a file when WRITE_FILE is set.
set -e
echo '{"type":"text","data":"mock-grok response"}'
if [ -n "${WRITE_FILE:-}" ]; then
  echo "mock change" >> "$WRITE_FILE"
fi
echo '{"type":"end","sessionId":"mock-session-id","stopReason":"EndTurn"}'
exit 0
