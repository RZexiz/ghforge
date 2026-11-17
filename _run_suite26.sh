#!/bin/bash
# Run one local pass of the github-core-clone-01 suite against /root/ghforge.
# Usage: _run_suite.sh <tag>
set -u
TAG="${1:-run}"
KIT=/root/makefun-kits/github-core-clone-01-kit
STATE="/tmp/mfstate_$TAG"
PORT=$((8400 + RANDOM % 200))
rm -rf "$STATE" && mkdir -p "$STATE"

MAKEFUN_ENV_HOST=127.0.0.1 MAKEFUN_ENV_PORT="$PORT" MAKEFUN_STATE_DIR="$STATE" \
  MAKEFUN_SHOP_TOKEN=practice-token MAKEFUN_TRIAL_WALL_BUDGET_SEC=420 \
  /root/.hermes/tools/node-26.7.0-linux-x64/bin/node "$KIT/program/env/server.mjs" >"/tmp/mfenv_$TAG.log" 2>&1 &
ENVPID=$!

# wait for <state>/ready
for _ in $(seq 1 60); do [ -s "$STATE/ready" ] && break; sleep 0.5; done
if [ ! -s "$STATE/ready" ]; then echo "ENV FAILED TO START"; cat "/tmp/mfenv_$TAG.log"; kill $ENVPID 2>/dev/null; exit 1; fi

cd /root/ghforge || exit 1
MAKEFUN_ENV_URL="http://127.0.0.1:$PORT" MAKEFUN_SHOP_TOKEN=practice-token \
  /root/.hermes/tools/node-26.7.0-linux-x64/bin/node --experimental-strip-types main.ts >"/tmp/mfentry_$TAG.log" 2>&1 &
ENTRYPID=$!

# the suite writes export/state.json when it is done
for _ in $(seq 1 200); do [ -s "$STATE/export/state.json" ] && break; sleep 1; done
sleep 3

kill $ENTRYPID 2>/dev/null
kill $ENVPID 2>/dev/null
wait $ENTRYPID 2>/dev/null
wait $ENVPID 2>/dev/null

echo "STATE=$STATE"
python3 - "$STATE" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]+'/export/state.json'))
c=d['counts']; g=c['byGroup']
feat=round(600*c['passed']/c['total'])
agent=round(200*g['mcp']['passed']/g['mcp']['total'])
perf=sum(d['perfTiers'].values())
print('groups:', {k:f"{v['passed']}/{v['total']}" for k,v in g.items()})
print(f"FEATURE {feat}/600  AGENT {agent}/200  PERF {perf}/200")
print(f"TOTAL {feat+agent+perf}/1000   working={d['working']}")
fails=[k for k,v in d['checks'].items() if not v]
print(f"FAILS({len(fails)}):", ','.join(fails))
PY
