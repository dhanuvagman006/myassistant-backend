# Bills by email — owner setup

Each user can turn on a private address (for example
`7k2m-q9xw-4tnp@in.hariassistant.tech`). Bills, e-tickets and policy renewals
forwarded to it are saved in **My documents**, reminders are set, and one
notification is sent. Nothing in an email can make the assistant send, pay,
reply, delete or open anything.

The feature ships **switched off**. Until you finish the steps below:

- the backend opens no mail port (`MAILIN_ENABLED` is unset),
- the app (build 120) hides the "Bills by email" card, because the server
  reports it as unavailable,
- your business mail on `hariassistant.tech` is never touched — only a new
  subdomain is added, and only in the last step.

Do the steps **in this order**. DNS comes last, so no mail can arrive before
the receiver works.

---

## 0. Pick the subdomain

The address domain is one setting, `MAILIN_DOMAIN`. It has not been chosen
yet. Below, `SUB` stands for your choice:

- `in` → addresses look like `…@in.hariassistant.tech`
- `bills` → addresses look like `…@bills.hariassistant.tech` (easier to read out)

Once users have addresses, changing it would break them, so choose before
switching the feature on.

## 1. Write down today's mail records

On any computer:

```
nslookup -type=mx hariassistant.tech
nslookup -type=txt hariassistant.tech
```

Keep the output. At the end (step 10) the three Zoho MX records and the SPF /
Zoho verification TXT records must be exactly the same.

## 2. Deploy the backend, still switched off

Deploy as usual (`scripts/deploy_vps.sh`) with `MAILIN_ENABLED` not set.
Nothing changes for users.

## 3. Check that port 25 is free on the VPS

```
ssh root@<VPS IP> "ss -ltnp | grep -E ':25\b' || echo free"
```

`<VPS IP>` is the address the `api.hariassistant.tech` record points to.
If something (postfix, exim) is already listening on port 25, **stop here and
ask** before removing it — it may be sending the server's own system mail.

## 4. Open inbound TCP port 25

- Hostinger hPanel → VPS → Security → Firewall: add **Accept, TCP, port 25,
  from any** (only if the panel firewall is in use).
- On the VPS: `ufw status`. If it says active: `ufw allow 25/tcp`.

## 5. Give the receiver its own TLS key (self-signed is fine)

Sending mail servers encrypt opportunistically and accept a self-signed key.
On the VPS:

```
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout /root/mailin.key -out /root/mailin.crt -subj "/CN=mx.SUB.hariassistant.tech"
k3s kubectl -n myassistant create secret generic mailin-tls \
  --from-file=tls.key=/root/mailin.key --from-file=tls.crt=/root/mailin.crt
shred -u /root/mailin.key /root/mailin.crt
```

The key only ever lives in the Kubernetes secret.

## 6. Switch it on in the config

```
k3s kubectl -n myassistant patch configmap myassistant-config --type merge -p \
 '{"data":{"MAILIN_ENABLED":"1","MAILIN_DOMAIN":"SUB.hariassistant.tech","MAILIN_HOSTNAME":"mx.SUB.hariassistant.tech","MAILIN_TLS_KEY_FILE":"/app/mailin-tls/tls.key","MAILIN_TLS_CERT_FILE":"/app/mailin-tls/tls.crt"}}'
```

Optional settings (defaults in brackets): `MAILIN_MAX_MB` (10),
`MAILIN_DAILY_CAP` emails per address per day (25),
`MAILIN_GLOBAL_HOURLY_CAP` (500), `MAILIN_MAX_FILES` per email (5),
`MAILIN_REMIND_UNVERIFIED` (0 — reminders only for mail from the user's own
address or a company whose signature checks out; everything else needs one
tap in the app).

## 7. Add the mail port to the running deployment

Use `patch` — never `kubectl apply` of `k8s/10-deployment.yaml` (its header
explains why):

```
k3s kubectl -n myassistant patch deployment myassistant-backend --type json -p '[
 {"op":"add","path":"/spec/template/spec/containers/0/ports/-","value":{"name":"smtp","containerPort":2525}},
 {"op":"add","path":"/spec/template/spec/volumes/-","value":{"name":"mailin-tls","secret":{"secretName":"mailin-tls","optional":true}}},
 {"op":"add","path":"/spec/template/spec/containers/0/volumeMounts/-","value":{"name":"mailin-tls","mountPath":"/app/mailin-tls","readOnly":true}}]'
```

This restarts the pod. Check the log:

```
k3s kubectl -n myassistant logs deploy/myassistant-backend | grep mailin
```

You should see `mailin: SMTP on :2525 for SUB.hariassistant.tech (tls: own)`.

## 8. Expose port 25

Copy `k8s/40-smtp-service.yaml` to the VPS, then:

```
k3s kubectl apply -f 40-smtp-service.yaml
k3s kubectl -n kube-system get pods | grep svclb-myassistant-smtp
```

The `svclb` pod should be **Running**. If no `svclb` pod appears (this
cluster has no ServiceLB), delete the Service again and instead add
`"hostPort":25` to the smtp port in step 7
(`{"name":"smtp","containerPort":2525,"hostPort":25}`). Use one or the other,
never both.

## 9. Check that port 25 is reachable from outside

Home internet providers often block port 25, so test from another server or
a public SMTP test website:

```
openssl s_client -starttls smtp -connect <VPS IP>:25 -crlf
```

Expected first line after the certificate: `220 mx.SUB.hariassistant.tech ESMTP ready`.

**If this fails, stop here.** Leave DNS alone and ask for the fallback
(a relay that posts mail to the backend over HTTPS); nothing else needs to
change.

## 10. DNS (last)

hPanel → Domains → hariassistant.tech → DNS / Nameservers → Manage DNS
records. **Do not edit or delete any `@` record.** Add:

| Type | Name | Value | Priority | TTL |
|---|---|---|---|---|
| A | `mx.SUB` | `<VPS IP>` | | 300 |
| MX | `SUB` | `mx.SUB.hariassistant.tech` | 10 | 300 |
| TXT | `SUB` | `v=spf1 -all` | | 300 |
| TXT (optional) | `_dmarc.SUB` | `v=DMARC1; p=reject` | | 300 |

Do **not** add an AAAA record for `mx.SUB` (port 25 over IPv6 is not set up).
The two TXT records say that nothing ever sends mail *as* this subdomain.

Then check:

```
nslookup -type=mx SUB.hariassistant.tech     → mx.SUB.hariassistant.tech
nslookup -type=mx hariassistant.tech         → still the three Zoho servers
```

Compare with what you wrote down in step 1.

## 11. Try it on a phone (build 120)

- You → Bills by email → **Turn on** → **Copy**.
- From a personal mailbox, forward a real bill PDF to the address. Within
  about a minute: a notification ("Did you forward this?"), and the document
  in My documents with the email badge. Open Bills by email → **This was me**
  → the reminders appear. Forward a second bill from the same mailbox →
  reminders are set straight away.
- If possible, set up automatic forwarding for one biller in a Gmail
  account: the confirmation code appears on the Bills by email screen (never
  in the notification), and the next bill from that biller arrives with
  reminders already set.
- Send to a made-up address such as `abcd-efgh-jkmn@SUB.hariassistant.tech`
  → it bounces with "Address not in use".
- Switch **Receive emails** off, send again → it bounces. Switch on → works.
- Send one email to your business address → it still arrives in Zoho.

## 12. Privacy page

Add one paragraph to the privacy policy, in the client's wording:

> If you turn on Bills by email, emails you forward to your address are read
> to save the bill or ticket in your documents and set reminders. Emails with
> one-time codes are skipped without being read. The email itself is deleted
> once saved; the saved documents stay until you delete them or your account.

## Turning it off again

Any of these, at any time:

- set `MAILIN_ENABLED` to `0` in the configmap and restart the deployment —
  senders are refused and retry or bounce, and the app hides the card;
- `k3s kubectl delete -f 40-smtp-service.yaml` — closes port 25;
- delete the `SUB` MX record.

Your business mail is not involved in any of these.
