#!/usr/bin/env bash
# FINISH AGENT CALLING — run this the moment a phone number exists.
#
#   scripts/finish_agent_calls.sh +918012345678
#
# Everything else — API key, agent, webhook, app wiring — is already in
# place and verified (2026-09-20). This validates the number against the
# provider's own API, writes it into the deployment, restarts, and proves
# the feature came up. It buys nothing and creates no account.
set -euo pipefail

NUM="${1:-}"
PROVIDER="bolna"
VPS="root@api.hariassistant.tech"
NS="myassistant"

if [[ -z "$NUM" ]]; then
  echo "usage: $0 <bolna-number-in-E.164>" >&2
  echo "  e.g. $0 +918012345678" >&2
  exit 2
fi
if [[ ! "$NUM" =~ ^\+[1-9][0-9]{7,14}$ ]]; then
  echo "that is not an E.164 number (needs the + and country code): $NUM" >&2
  exit 2
fi

echo "→ provider: $PROVIDER   number: $NUM"

# 1. The number must really belong to the account, or the first call
#    fails in front of the user instead of failing here.
# 2. Store it. `set env` patches the deployment in place — no image
#    rebuild, because the code has read these vars since 2026-09-18.
KEY_NAME="BOLNA_FROM_NUMBER"
echo "→ setting $KEY_NAME and restarting…"
ssh "$VPS" "k3s kubectl set env deploy/myassistant-backend -n $NS $KEY_NAME='$NUM' >/dev/null && k3s kubectl rollout status deploy/myassistant-backend -n $NS --timeout=180s | tail -1"

# 3. Prove it, from inside the running pod.
echo "→ verifying…"
ssh "$VPS" "POD=\$(k3s kubectl get pods -n $NS -l app=myassistant-backend --sort-by=.metadata.creationTimestamp -o name | tail -1); POD=\${POD#pod/}; k3s kubectl exec -n $NS \$POD -- node -e '
const a=require(\"/app/src/agents/agentCall\");
console.log(\"  provider:\", a.provider(), \"| enabled:\", a.enabled());
if(!a.enabled()) process.exit(1);
'"

echo
echo "AGENT CALLING IS LIVE."
echo 'Test on YOUR OWN number first: "call me and remind me to drink water"'
