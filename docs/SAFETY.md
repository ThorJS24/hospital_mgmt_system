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
| SSRF scenario can contact loopback IP literals only; 4 KB response cap | `vulnerable/ssrf.ts` |
| Upload scenario: size limit, stored outside web root, never executed | `vulnerable/routes.ts` |
| Path traversal sandboxed to `lab-data/` | `vulnerable/routes.ts` |
| Reset only via local CLI; refuses non-local DB hosts and production | `backend/src/db/cli.ts` |
| Assessment data only for the assessor role; hospital admins cannot manage assessors | `permissions.ts`, `routes/admin.ts` |
| Fake sensitive data is invalid by construction (SSN 9xx, processor test cards, `.example.test`) | `db/seed.ts` |
| No outbound HTTP code other than the contained SSRF client | `vulnerable/ssrf.ts` is the only client |

## Disabling the vulnerable configuration
Run `npm run start:secure` (or `docker compose up` without the lab override). Every `/api/lab/*` route returns 404 and all inline weaknesses (mass assignment, weak reset token, session fixation, user enumeration, unsafe note rendering) are off.

## Resetting
`npm run db:reset` rebuilds the synthetic clinical data and preserves assessment records; add `-- --include-assessment` to wipe those too.
