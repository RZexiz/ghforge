#!/bin/bash
# One clean local pass: fresh in-memory forge on a free port, then the kit's own conformance runner.
# Usage: ./_grade.sh [--perf] [--full]
#   every run starts a new server, so no repository from an earlier pass can make a push stale.
set -u
KIT=/root/makefun-kits/github-core-clone-01-kit
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
LOG=/tmp/ghforge_grade_$PORT.log

cd /root/ghforge || exit 1
GHFORGE_DEBUG=1 node --experimental-strip-types -e "
const {createApp}=await import('./app.ts');
const s=createApp();
await new Promise(r=>s.listen($PORT,'127.0.0.1',r));
console.log('up');
" >"$LOG" 2>&1 &
SRV=$!

for _ in $(seq 1 40); do grep -q up "$LOG" 2>/dev/null && break; sleep 0.25; done
if ! grep -q up "$LOG" 2>/dev/null; then echo "SERVER FAILED"; cat "$LOG"; kill $SRV 2>/dev/null; exit 1; fi

cd "$KIT" || exit 1
node --experimental-strip-types sdk/run.ts --url "http://127.0.0.1:$PORT" --token practice-token "$@"
RC=$?
kill $SRV 2>/dev/null
wait $SRV 2>/dev/null
if grep -q 'receive-pack\]' "$LOG" 2>/dev/null; then
  echo "--- server errors ---"
  grep -A3 'receive-pack\]' "$LOG" | head -40
fi
exit $RC
