#!/usr/bin/env bash
# DEPLOY TO THE VPS — one command, backed up, and rolled back on failure.
#
#   scripts/deploy_vps.sh              deploy origin/main
#   scripts/deploy_vps.sh my-branch    deploy origin/my-branch
#   scripts/deploy_vps.sh --local      deploy this checkout's HEAD (no push
#                                      needed: the commits travel as a git
#                                      bundle over ssh)
#
# Production is not a registry image: k3s runs `myassistant-backend:local`
# (imagePullPolicy: Never), built on the VPS from /opt/myassistant-backend.
# This script is that procedure, written down so it is the same every time:
#
#   1. refuse if the server checkout has local edits
#   2. take a database backup with the postgres-backup CronJob, and stop
#      unless it completes (the job verifies the dump itself)
#   3. keep the running image as :previous — the rollback point
#   4. build, and prove the new image can load the app before using it
#   5. import into k3s, restart, wait for the rollout
#   6. poll /health; on ANY failure after step 5, put :previous back
#
# Env: VPS (default root@200.141.9.112), HEALTH_URL,
#      DRY_RUN=1 — fetch, back up, build and check the image, then stop:
#      the running service and the server checkout are not touched.
set -euo pipefail

VPS="${VPS:-root@200.141.9.112}"
DRY_RUN="${DRY_RUN:-0}"
HEALTH_URL="${HEALTH_URL:-https://api.hariassistant.tech/health}"
REPO_DIR=/opt/myassistant-backend
MODE=origin
REF="${1:-main}"
if [ "${1:-}" = "--local" ]; then MODE=local; REF=deploy-local; fi

say() { printf '\n==> %s\n' "$*"; }

if [ "$MODE" = local ]; then
  say "bundling local HEAD ($(git rev-parse --short HEAD)) for the server"
  git diff --quiet && git diff --cached --quiet || {
    echo "uncommitted changes here — commit them first" >&2; exit 1; }
  BUNDLE="$(mktemp -d)/deploy.bundle"
  git bundle create "$BUNDLE" HEAD >/dev/null 2>&1
  scp -q "$BUNDLE" "$VPS:/tmp/deploy.bundle"
fi

say "deploying $MODE:$REF to $VPS"
# shellcheck disable=SC2087 — expanded locally on purpose (MODE/REF/URL)
ssh -o BatchMode=yes "$VPS" bash -s <<EOF
set -euo pipefail
K="k3s kubectl -n myassistant"
C="k3s ctr -n k8s.io"
IMG=docker.io/library/myassistant-backend
say() { printf '\n--> %s\n' "\$*"; }

cd $REPO_DIR
if [ -n "\$(git status --porcelain)" ]; then
  echo "server checkout has local edits — refusing to overwrite them" >&2
  git status --short >&2; exit 1
fi

say "1/6 fetching code"
if [ "$MODE" = local ]; then
  git fetch -q /tmp/deploy.bundle HEAD
else
  git fetch -q origin "$REF"
fi
TARGET=\$(git rev-parse FETCH_HEAD)
echo "target \$(git log --oneline -1 \$TARGET)"
# The image is built from the commit itself (git archive), never from
# whatever happens to be in the working tree.
TAG=local
if [ "$DRY_RUN" = 1 ]; then TAG=dryrun; else git checkout -q --detach "\$TARGET"; fi

say "2/6 database backup"
J="predeploy-\$(date +%Y%m%d%H%M%S)"
\$K create job --from=cronjob/postgres-backup "\$J" >/dev/null
\$K wait --for=condition=complete "job/\$J" --timeout=300s
\$K logs "job/\$J" | tail -1

say "3/6 keeping the running image as :previous"
if [ "$DRY_RUN" = 1 ]; then echo "(dry run: skipped)"; else
  \$C images tag --force "\$IMG:local" "\$IMG:previous" >/dev/null
fi

say "4/6 building \$TAG"
git archive --format=tar "\$TARGET" | docker build -q -t "myassistant-backend:\$TAG" - >/dev/null
docker run --rm -e DATABASE_URL=postgres://x:y@127.0.0.1:1/z \
  -e JWT_SECRET=deploy-check-0123456789012345678901234567 \
  "myassistant-backend:\$TAG" node -e "
    require('./src/tools/builtins').registerBuiltins();
    require('./src/ai/routes'); require('./src/shopping'); require('./src/appfunctions');
    require('./src/routes/auth');
    console.log('image loads on', process.version);" 2>&1 | grep -v '"level"'

if [ "$DRY_RUN" = 1 ]; then
  docker rmi -f myassistant-backend:dryrun >/dev/null
  echo; echo "DRY RUN OK — nothing was restarted"; exit 0
fi

rollback() {
  echo "!!! \$1 — rolling back to :previous" >&2
  \$C images tag --force "\$IMG:previous" "\$IMG:local" >/dev/null
  \$K rollout restart deploy/myassistant-backend
  \$K rollout status deploy/myassistant-backend --timeout=240s
  exit 1
}

say "5/6 rolling out"
docker save myassistant-backend:local | \$C images import - >/dev/null
\$K rollout restart deploy/myassistant-backend
\$K rollout status deploy/myassistant-backend --timeout=240s || rollback "rollout did not finish"

say "6/6 health"
for i in \$(seq 1 30); do
  if curl -fsS -m 5 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then
    echo "healthy: \$(curl -fsS -m 5 "$HEALTH_URL")"
    docker image prune -f >/dev/null   # dangling layers only; tagged images stay
    exit 0
  fi
  sleep 3
done
rollback "no healthy /health within 90s"
EOF
[ "$DRY_RUN" = 1 ] && exit 0
say "deployed. Roll back by hand with:"
echo "  ssh $VPS 'k3s ctr -n k8s.io images tag --force docker.io/library/myassistant-backend:previous docker.io/library/myassistant-backend:local && k3s kubectl -n myassistant rollout restart deploy/myassistant-backend'"
