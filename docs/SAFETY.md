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
| Reset only via local CLI; refuses non-local DB hosts and production | `backend/src/db/cli.ts` |
| Assessment data only for the assessor role; hospital admins cannot manage assessors | `permissions.ts`, `routes/admin.ts` |
| Fake sensitive data is invalid by construction (SSN 9xx, processor test cards, `.example.test`) | `db/seed.ts` |
| No outbound HTTP code | SSRF scenario was remediated and removed |

## Disabling the vulnerable configuration
Run `npm run start:secure` (or `docker compose up` without the lab override). Every `/api/lab/*` route returns 404 and all inline weaknesses (mass assignment, weak reset token, session fixation, user enumeration, unsafe note rendering) are off.

## Resetting
`npm run db:reset` rebuilds the synthetic clinical data and preserves assessment records; add `-- --include-assessment` to wipe those too.

## Features added after the hardening pass
- New endpoints follow the same controls as the rest of the API: zod validation, parameterised SQL, `requirePermission`, CSRF on every unsafe method, and object-level scoping where records belong to a care team.
- The patient portal derives the patient from the session, so there is no patient identifier in any portal URL or body to tamper with.
- CSV exports prefix cells that start with `=`, `+`, `-` (non-numeric), `@`, tab or CR with an apostrophe to prevent spreadsheet formula injection.
- PDFs are produced server-side from plain data (no HTML rendering, no remote resources). Filenames in `Content-Disposition` are generated from sanitised identifiers.
- Reminders and confirmations are written to a local table; the application still makes no outbound HTTP, SMTP or SMS calls.
- API reference pages are administrator-only and served with a strict Content-Security-Policy (`script-src 'self'`).
- The five intentionally remaining weaknesses (HMS-V03, V10, V14, V17, V18) are unchanged and only exist in lab mode.
