#!/bin/bash
# Reproduce the push->clone cycle against a live ghforge with a real git client.
set -u
cd /root/ghforge || exit 1
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
LOG=/tmp/repro_srv_$PORT.log
GHFORGE_DEBUG=1 node --experimental-strip-types -e "
const {createApp}=await import('./app.ts');
const s=createApp();
await new Promise(r=>s.listen($PORT,'127.0.0.1',r));
console.log('up');
" >"$LOG" 2>&1 &
SRV=$!
for _ in $(seq 1 40); do grep -q up "$LOG" 2>/dev/null && break; sleep 0.25; done
if ! grep -q up "$LOG" 2>/dev/null; then echo "SERVER FAILED"; cat "$LOG"; kill $SRV 2>/dev/null; exit 1; fi
echo "PORT=$PORT LOG=$LOG"

export HOME=/tmp/repro_home_$PORT
rm -rf "$HOME" /tmp/repo_local_$PORT; mkdir -p "$HOME"

AUTH="-H Authorization:Bearer\ practice-token"
BASE="http://127.0.0.1:$PORT"

# 1. create repo over REST
echo "--- create repo ---"
curl -s -X POST "$BASE/api/v3/user/repos" -H 'Authorization: Bearer practice-token' \
  -H 'Content-Type: application/json' -d '{"name":"rg","private":false}' | head -c 300
echo

# 2. clone empty, commit, push
git init -q /tmp/repo_local_$PORT && cd /tmp/repo_local_$PORT
git config user.email t@t.t && git config user.name t
echo hello > a.txt && git add . && git commit -qm "first"
git remote add origin "$BASE/adaiversen/rg.git"
echo "--- push ---"
GIT_TRACE_PACKET=1 GIT_TRACE=1 git -c http.extraHeader='Authorization: Bearer practice-token' push origin HEAD:refs/heads/main 2>&1 | tail -20
echo "PUSH_RC=$?"

# 3. clone it back
cd /root
echo "--- clone back ---"
rm -rf /tmp/repo_clone_$PORT
GIT_TRACE_PACKET=1 git -c http.extraHeader='Authorization: Bearer practice-token' \
  clone "$BASE/adaiversen/rg.git" /tmp/repo_clone_$PORT 2>&1 | tail -20
echo "CLONE_RC=$?"
ls -la /tmp/repo_clone_$PORT 2>/dev/null | head

echo "=== SERVER LOG ==="
tail -40 "$LOG"
kill $SRV 2>/dev/null
wait $SRV 2>/dev/null
