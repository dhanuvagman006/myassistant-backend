# Deployment Guide — MYASSISTANT_BACKEND on Kubernetes

End-to-end runbook. Prereqs: a Kubernetes cluster (GKE / EKS / DigitalOcean /
k3s all fine), `kubectl` pointed at it, and `helm` v3.

## 1. CI/CD (already wired)

`.github/workflows/ci-cd.yml` runs on every push/PR:

- **test** — `npm test` (self-contained smoke tests, no API keys)
- **build-and-push** — Docker image to `ghcr.io/dhanuvagman006/myassistant_backend`,
  tagged `sha-<commit>` and `latest` on main
- **deploy** (main only) — `kubectl set image`, waits for rollout, and
  **auto-rolls-back** to the previous revision if the rollout fails

To enable the deploy job, add one repo secret:

```bash
base64 -w0 ~/.kube/config   # paste output as secret KUBE_CONFIG
```

Make the GHCR package public (repo → Packages → package settings →
visibility) or add an imagePullSecret to the Deployment.

## 2. First deploy

```bash
kubectl apply -f k8s/00-namespace-config.yaml

# Create real secrets (see full command list in k8s/01-secret.example.yaml)
kubectl -n myassistant create secret generic myassistant-secrets \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=GEMINI_API_KEY="..." \
  --from-literal=GROQ_API_KEY="..."

kubectl apply -f k8s/10-deployment.yaml
kubectl -n myassistant get pods -w        # wait for Running 1/1
kubectl -n myassistant port-forward svc/myassistant-backend 3000:80
curl localhost:3000/health                # {"ok":true,...}
```

## 3. Ingress + HTTPS

Install ingress-nginx and cert-manager (commands in the header of
`k8s/30-ingress.yaml`), point your DNS A record at the ingress
LoadBalancer IP, edit the host + email in that file, then:

```bash
kubectl apply -f k8s/30-ingress.yaml
kubectl -n myassistant get certificate    # READY=True within ~2 min
```

Also update `PUBLIC_BASE_URL` in the ConfigMap to the real https URL
(OAuth callbacks and Plivo webhooks depend on it), then restart:
`kubectl -n myassistant rollout restart deploy/myassistant-backend`.

## 4. Autoscaling — read this first

The app now runs on Postgres (`k8s/05-postgres.yaml`), so the HPA is
safe to apply. Install Metrics Server first if the cluster lacks it:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

Then: `kubectl apply -f k8s/40-hpa.yaml`. The Deployment already uses
RollingUpdate. Existing SQLite data can be imported with
`scripts/migrate-sqlite-to-postgres.js` (usage in the file header).
Note: the document-files PVC is ReadWriteOnce, so replicas co-locate on
one node; for multi-node scale-out move files to S3-compatible storage.

## 5. Monitoring, logs, alerts

See `(moved to the MYASSISTANT_MONITORING repo) README.md` — three Helm commands install
Prometheus + Grafana + Alertmanager + Loki + Promtail, and
`alerts.yaml` adds app-specific alerts (backend down, crash-looping,
memory/CPU pressure, disk filling, backup failures). Point Alertmanager
at Slack/Telegram in `kube-prometheus-values.yaml`.

## 6. Backups & restore

The `postgres-backup` CronJob runs `pg_dump` nightly at 21:00 UTC (02:30
IST), gzips it to `backups/` on the `myassistant-data` PVC, checks the
dump is complete, and keeps the newest 14. (k3s is used on the VPS, so
prefix `kubectl` with `k3s` there.)

```bash
kubectl apply -f k8s/50-backup-cronjob.yaml
# take one now instead of waiting for tonight (do this before any deploy):
kubectl -n myassistant create job --from=cronjob/postgres-backup backup-now
kubectl -n myassistant logs job/backup-now -f     # "backup done: …"
```

On the VPS the files are under
`/var/lib/rancher/k3s/storage/<myassistant-data volume>/backups/`.

**Restore** (replaces the database with the dump — take a fresh backup
first so the current state is recoverable too):

```bash
kubectl -n myassistant scale deploy/myassistant-backend --replicas=0
PG=$(kubectl -n myassistant get pod -l app=postgres -o name | head -1)
gunzip -c myassistant-<stamp>.sql.gz > /tmp/restore.sql
kubectl -n myassistant cp /tmp/restore.sql ${PG#pod/}:/tmp/restore.sql
kubectl -n myassistant exec $PG -- sh -c \
  'dropdb -U "$POSTGRES_USER" --if-exists myassistant_restore &&
   createdb -U "$POSTGRES_USER" myassistant_restore &&
   psql -U "$POSTGRES_USER" -d myassistant_restore -v ON_ERROR_STOP=1 -q -f /tmp/restore.sql'
# check it, then swap names (the app reads POSTGRES_DB):
kubectl -n myassistant exec $PG -- sh -c \
  'psql -U "$POSTGRES_USER" -d postgres -c "ALTER DATABASE \"$POSTGRES_DB\" RENAME TO myassistant_old" \
                                         -c "ALTER DATABASE myassistant_restore RENAME TO \"$POSTGRES_DB\""'
kubectl -n myassistant scale deploy/myassistant-backend --replicas=1
```

Restoring into a side database and swapping names means a bad dump never
overwrites the live data. Verified 2026-09-23: a dump restores cleanly
into an empty database (all tables and rows match the source).

**Limit:** the backups share the node and disk with the data. They cover
a bad deploy or a mistaken delete, not the loss of the server. Add an
off-server copy at the marked line in the CronJob.

## 7. Rollback (manual)

CI rolls back automatically on failed rollouts. Manually:

```bash
kubectl -n myassistant rollout history deploy/myassistant-backend
kubectl -n myassistant rollout undo deploy/myassistant-backend            # previous
kubectl -n myassistant rollout undo deploy/myassistant-backend --to-revision=3
```

Note: rollback reverts code, not data. If a bad release corrupted the DB,
restore from the nightly backup as above.

## Plivo agent calling ("call X and tell them Y" — Hari speaks on the call)

Plivo is the ONLY telephony provider. Exotel was removed on 2026-09-13:
its balance was exhausted, and its dashboard flows cannot be driven by
response XML, so there was never a usable two-way path. Retell remains in
the tree as an inert fallback but a configured Plivo always wins — Retell
is a hosted agent, and the point of Plivo is a number bridged straight to
our own WebSocket, so the call runs on our model with the user's memory.

1. Create a Plivo account and finish KYC. **Indian numbers can only be
   rented by India-registered businesses** (Certificate of Incorporation +
   GST), so this is a company action, not a developer one.
2. Rent an Indian number. Published rates at the time of writing:
   Rs 200/month for the number, Rs 0.38/min domestic — confirm current
   pricing on their console rather than trusting this line.
3. Set the credentials (never commit them):

   ```
   kubectl -n myassistant patch secret myassistant-secrets --type=merge \
     --patch-file /root/plivo.json    # {"stringData":{"PLIVO_AUTH_ID":"…"}}
   kubectl -n myassistant rollout restart deploy/myassistant-backend
   ```

   `PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN, PLIVO_FROM_NUMBER`

4. Verify: the admin Debug page reports the active provider, and
   `GET /agent-call/:id` returns the call record. `provider()` returns
   "plivo" as soon as all three are set — no code change or redeploy of
   the image is needed, only the rollout above.
