# Architecture

## Overview
```
Browser (React SPA, :5173)  ──/api proxy──▶  Express API (:4000)  ──▶  PostgreSQL (Docker) | PGlite (embedded)
                                                │
                                                ├─ routes/        HTTP handlers + zod validation
                                                ├─ services/      business rules, permissions, assessment, live bus, simulator
                                                ├─ middleware/    sessions, CSRF, security headers, authorization
                                                └─ assessment/vulnerable/   intentional weaknesses (lab mode only)
```
The Vite dev server proxies `/api` to the backend, so the SPA and API share an origin and the session cookie is `HttpOnly; SameSite=Lax`.

## Backend
- **Config:** `backend/src/config` reads the environment once. `assertSafeBinding` enforces loopback binding in vulnerable mode.
- **Database:** `db/index.ts` exposes one `Db` interface backed by `pg` (when `DATABASE_URL` is set) or PGlite. SQL migrations in `backend/migrations` (`001` core, `002` assessment, `003` extended patient data, `004` clinical workflow, operations, portal and account security) are tracked in `schema_migrations`. `db/seed.ts` is deterministic and idempotent for assessment definitions; clinical data is rebuilt by `TRUNCATE … RESTART IDENTITY`.
- **Sessions:** server-side `sessions` table, opaque 192-bit ids, rotation at login, idle expiry. Every unsafe request needs the session-bound `X-CSRF-Token`.
- **Authorization:** `services/permissions.ts` is the single permission matrix (seeded into `roles`/`permissions`/`role_permissions`). `requirePermission` guards routes; `services/patients.ts` (`scopeClause`, `canAccessPatient`) implements object-level scoping: doctors see their care team, nurses their department, others by permission. Hospital administrators have no `assessment.*` permissions.
- **Validation:** zod schemas at the trust boundary; list endpoints use whitelisted `ORDER BY` columns and bound parameters.
- **Live data:** `services/live.ts` is an in-process event bus feeding `GET /api/live` (SSE). `services/simulator.ts` makes synthetic changes every few seconds. Event messages contain no patient identity.
- **Assessment:** separate tables (`assessment_*`, `remediation_records`) with no foreign keys into clinical tables. `services/assessment.ts` holds the finding state machine, CVSS-band validation, evidence sanitisation and metrics; `services/report.ts` renders JSON/CSV/HTML from stored records.

## Data model (summary)
Clinical: `users, roles, permissions, role_permissions, sessions, reset_tokens, departments, staff, patients (+ identifiers, insurance), patient_contacts, patient_allergies, medical_histories, patient_documents, patient_payment_methods, medical_procedures, patient_vitals, appointments, wards, beds, admissions, laboratory_tests/requests/results, medications, prescriptions(+items), invoices(+items), payments, audit_events, system_config`.
Assessment: `assessment_projects, assessment_findings, assessment_finding_history, assessment_test_cases, assessment_results, assessment_evidence, remediation_records`.
Integrity rules in SQL: unique active bed and unique active admission per patient, check constraints on statuses, positive quantities and amounts.

## API surface (secure routes)
`/api/auth/*`, `/api/profile*`, `/api/patients*`, `/api/documents/:id`, `/api/appointments*`, `/api/wards`, `/api/admissions*`, `/api/staff*`, `/api/departments*`, `/api/laboratory/*`, `/api/pharmacy/*`, `/api/invoices*`, `/api/dashboard`, `/api/reports/operational`, `/api/admin/*`, `/api/assessment/*`, `/api/live*`, `/api/health`. Intentionally weak routes live under `/api/lab/*` and exist only in vulnerable mode.

## Frontend
React Router SPA; `lib/api.ts` attaches the CSRF token; `lib/auth.tsx` holds the session and role helpers; `lib/live.tsx` subscribes to SSE and exposes a tick that tables and the dashboard use to refresh. UI primitives (`components/ui.tsx`) provide the table, form, dialog, badge and card components; theme tokens are CSS variables so dark mode applies everywhere. Navigation is role-aware but only a convenience: the backend re-checks every call.

## Clinical workflow and operations (migration 004)
- **Consultations** (`routes/consultations.ts`): a draft is editable only by its authoring doctor; signing locks it, links the primary ICD-10 diagnosis to the problem list and completes the linked appointment. Lab orders and prescriptions are attached to the draft.
- **Prescribing** (`services/prescribing.ts`, `services/rx.ts`): the same function backs the dry-run check endpoint and prescription creation. Blocking findings (severe allergy or cross-reacting class, major interaction, dose above `max_daily_units`) return `409` with the warning list until an override reason of at least 10 characters is supplied; overrides are stored on the prescription and audited. Refills are tracked on the prescription and every stock change is written to `stock_movements`.
- **Clinical record keeping** (`routes/clinical.ts`): vitals with reference ranges (`services/vitals.ts`), the MAR (`mar_doses`, scoped by ward department for nurses and by attending doctor for doctors), discharge summaries with a PDF, and the triage queue (`triage_entries`, one active entry per patient enforced by a partial unique index).
- **Notifications** (`services/notifications.ts`): rows in `notifications` are private to one user. Idempotency comes from a partial unique index on `(user_id, dedupe_key)`, so periodic scans (overdue invoices, stock) never repeat an alert. `services/maintenance.ts` runs the scans, reminders and clean-up every 15 minutes (and on demand from Administration).
- **Staffing** (`services/staffing.ts`): `staff_shifts` and `staff_leave` feed `slotsFor`, which is shared by the staff slot view and patient self-service booking so both always agree.
- **Billing**: refunds are negative `payments` rows (`kind = 'Refund'`, `refund_of`), so every existing "sum of payments" calculation is automatically net of refunds. Insurance claims enforce one open claim per invoice and a different user for the decision.
- **Patient portal** (`routes/portal.ts`): the patient id always comes from the signed-in account (`users.patient_id`), never from the request. The `patient` role holds only `portal.access`, so every staff endpoint refuses it.
- **Account security** (`routes/auth.ts`, `services/totp.ts`): after a correct password, users with 2FA receive a short-lived single-purpose challenge (5 attempts, 5 minutes) and no session until the code (or an unused recovery code) is verified. TOTP steps are recorded to reject replays. Session identifiers are never returned by the sessions API; clients get an opaque reference.
- **API reference** (`routes/docs.ts`): the OpenAPI document is generated by introspecting the mounted routers and the permission middleware each route declares, so it cannot drift from the code. The intentionally vulnerable `/api/lab/*` routes are never listed.
- **Frontend additions**: `lib/i18n.tsx` (English, Spanish, Hindi), `lib/nav.ts` (single navigation model used by the sidebar, command palette and shortcuts), `components/` for the notification bell, command palette, shortcuts help, tour and charts.
