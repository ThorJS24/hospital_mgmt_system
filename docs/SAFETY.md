# Safety and responsible use

MediCore is **deliberately vulnerable**. Treat it like any other vulnerable training target.

## Rules
1. Run it only on a machine you own, on loopback (`127.0.0.1`). Do not port-forward, tunnel, or deploy it to any shared or public host.
2. Use it only with its synthetic data. Do not import real patient data, real credentials, or real card numbers.
3. Test only this application. Nothing here authorises testing any other system.
4. Evidence you collect may contain sensitive-looking data; the app redacts known secret patterns but review before sharing.

## What the code does to keep it contained
| Control | Where |
|---|---|
| Loopback bind enforced in vulnerable mode (container exception via `LAB_ALLOW_CONTAINER_BIND=1`, set only by Compose with 127.0.0.1 port mapping) | `backend/src/config/index.ts` |
| Weak routes only exist when `LAB_MODE=vulnerable`; individually switchable with `LAB_VULNS` | `backend/src/app.ts`, `assessment/vulnerable/*` |
| SQL scenarios: read-only transaction, single statement, statement timeout | `vulnerable/routes.ts`, `vulnerable/extra.ts` |
| Upload scenario: size limit, stored outside web root, never executed | `vulnerable/routes.ts` |
| Path traversal sandboxed to `lab-data/` | `vulnerable/routes.ts` |
| Reset and demo-password restore only via local CLI; both refuse non-local DB hosts and production, and neither has an HTTP endpoint | `backend/src/db/cli.ts` |
| Assessment data only for the assessor role; hospital admins cannot manage assessors | `permissions.ts`, `routes/admin.ts` |
| Fake sensitive data is invalid by construction (SSN 9xx, processor test cards, `.example.test`) | `db/seed.ts` |
| No outbound HTTP code | SSRF scenario was remediated and removed |

## Disabling the vulnerable configuration
Run `npm run start:secure` (or `docker compose up` without the lab override). Every `/api/lab/*` route returns 404 and all inline weaknesses (mass assignment, weak reset token, session fixation, user enumeration, unsafe note rendering) are off.

## Resetting
`npm run db:reset` rebuilds the synthetic clinical data and preserves assessment records; add `-- --include-assessment` to wipe those too.

### Locked out of a demo account
`npm run db:reset-passwords` (all demo accounts) or `npm run db:reset-passwords -- admin.hartley` restores the documented development password and keeps every other record. It also clears lockouts, two-step verification (secret and recovery codes), pending reset codes and open sessions, re-activates the account, and writes a `demo_password_restored` audit event. Only the accounts listed in the README are affected; accounts created through Administration are never touched. For the Docker setup use `npm run docker:reset-passwords`. With the embedded database, stop the backend first (only one process can open it).

## Features added after the hardening pass
- New endpoints follow the same controls as the rest of the API: zod validation, parameterised SQL, `requirePermission`, CSRF on every unsafe method, and object-level scoping where records belong to a care team.
- The patient portal derives the patient from the session, so there is no patient identifier in any portal URL or body to tamper with.
- CSV exports prefix cells that start with `=`, `+`, `-` (non-numeric), `@`, tab or CR with an apostrophe to prevent spreadsheet formula injection.
- PDFs are produced server-side from plain data (no HTML rendering, no remote resources). Filenames in `Content-Disposition` are generated from sanitised identifiers.
- Reminders and confirmations are written to a local table; the application still makes no outbound HTTP, SMTP or SMS calls.
- API reference pages are administrator-only and served with a strict Content-Security-Policy (`script-src 'self'`).
- The five intentionally remaining weaknesses (HMS-V03, V10, V14, V17, V18) are unchanged and only exist in lab mode.

## Hardening pass (secure mode)
The full control list, deployment checklist and known gaps are in [SECURITY.md](../SECURITY.md). Highlights beyond the earlier sections:
- Passwords: 15+ characters with no composition rules, common-password and pattern screening, personal-data check, last-5 reuse block, scrypt (N=2^16, r=8, p=2) with the work factor stored in the hash and an upgrade at the next sign-in; unknown, disabled and wrong-password sign-ins take the same time and give the same answer.
- Provisioning: administrator-created accounts and first-run production accounts must change the temporary password before any other call is allowed (`403 PASSWORD_CHANGE_REQUIRED`).
- Requests: per-client rate limits ahead of all other processing; `Origin` and `Sec-Fetch-Site` checks in addition to the CSRF token; `SameSite=Strict` cookies, `Secure` + `__Host-` prefix over HTTPS; HSTS; a 12-hour absolute session limit.
- Accountability: the audit table is append-only (database trigger) and records the client address; views of patient records, documents and consultations are audited.
- Delivery: containers run as a non-root user with capabilities dropped; Dependabot and CodeQL are configured.
