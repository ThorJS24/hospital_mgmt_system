# Security policy and governance

MediCore HMS is a teaching project with **synthetic data only**. It is built to the standard of a real clinical system so that the controls can be studied, but it has not been through a formal penetration test or certification and must not hold real patient data. "Secure mode" means *no known weaknesses and the full set of controls below*; no software can honestly claim to be flawless, so every control here is backed by an automated test and anything known to be missing is listed under [Known gaps](#known-gaps).

## Modes
| Mode | How | What it is |
|---|---|---|
| **Secure** (default) | `npm run start:secure`, `docker compose up` | Every control below is active. `/api/lab/*` does not exist (404). |
| **Lab** | `npm run start:lab` | Adds five deliberate weaknesses (HMS-V03, V10, V14, V17, V18) for assessment exercises. Loopback only, never with `NODE_ENV=production` (the server refuses to start). |

## Reporting a vulnerability
Please open a private security advisory on the GitHub repository (Security tab, "Report a vulnerability"). Do not post details in a public issue. Findings in the five deliberate lab weaknesses are expected and need no report; anything in **secure mode** is a bug we want to fix.

## Control summary (secure mode)

### Identity and passwords (NIST SP 800-63B-4, OWASP Authentication Cheat Sheet)
- **Policy:** 15 to 128 characters, any characters (spaces, Unicode, emoji), **no composition rules and no forced rotation**. Passwords are screened against common passwords and trivial variations (case, look-alike substitutions, repeated words, short suffixes), keyboard and alphabet runs, repeated characters, and the user's own username, name, email and the product name. The last **5** passwords cannot be reused. One shared definition (`shared/password-policy.json`, `shared/passwordPolicy.ts`) drives both the server and the live hints in the browser.
- **Storage:** scrypt (N=2^16, r=8, p=2, 64 MiB; OWASP-equivalent to N=2^17, p=1) with a random 16-byte salt and the work factor stored in each hash. Older hashes still verify and are **upgraded at the next successful sign-in**. Password history holds hashes only.
- **Sign-in:** generic errors (no user enumeration), one hash comparison on every attempt (unknown, disabled and wrong-password cost the same time), per-account lockout after 5 failures for 10 minutes, per-client rate limiting, audit of every success and failure.
- **Second factor:** TOTP (RFC 6238) with replay protection, single-use hashed recovery codes, and a single-purpose challenge (5 attempts, 5 minutes) that issues **no session** until the code is proven.
- **Recovery:** reset codes are random, expire after 30 minutes, allow 5 attempts, are compared in constant time, and the new password must meet the full policy. The response never reveals whether an account exists.
- **Provisioning:** accounts created by an administrator get a temporary password and **must choose their own before anything else works** (enforced by the API, not just the UI). In production the first-run demo accounts get random one-time passwords, and the server refuses to start if any account still has a published development password.
- **Sessions:** 192-bit random ids stored server-side; the id rotates at sign-in; 60-minute idle timeout and a 12-hour absolute limit; cookie is `HttpOnly`, `SameSite=Strict`, and with HTTPS also `Secure` with the `__Host-` prefix; users can list and revoke their sessions; changing a password signs out every other device.

### Authorization
- Deny by default: every route declares the permission it needs (`services/permissions.ts` is the single matrix; the generated API reference lists them).
- Object-level scoping: doctors and nurses see only their care team's patients; patients (portal) are bound to their own record by the server-side account link, never by an id in the request.
- Separation of duties: administrators hold no assessment permissions; the person who files an insurance claim cannot decide it; nobody approves their own leave.
- Segregation of the `patient` role: it holds a single permission and is refused by every staff endpoint (and by the live event stream).

### Request integrity
- CSRF: session-bound token on every state-changing request, **plus** `Sec-Fetch-Site` and `Origin` checks, **plus** `SameSite=Strict`.
- Input: schema validation (zod) at every boundary, parameterised SQL only, whitelisted sort columns, bounded sizes, file uploads checked by content signature, stored outside the web root.
- Output: React escapes by default (no raw HTML anywhere in secure mode); CSV exports neutralise spreadsheet formulas; PDFs are generated from plain data.
- Throttling: a general per-client request limit and a much tighter one on sign-in, second-factor and password-reset endpoints, applied **before** body parsing, session lookup and password hashing; `429` with `Retry-After`.

### Browser and transport
- Headers on every response: `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (camera, microphone, geolocation and more disabled), `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Cache-Control: no-store` for API data, and `Strict-Transport-Security` when served over HTTPS.
- When the API serves the built front end (`SERVE_FRONTEND=1`), the page CSP is `default-src 'self'; script-src 'self'` with no inline or eval scripts, `object-src 'none'`, `frame-ancestors 'none'`.
- No outbound network calls from the application. CORS is not enabled (same-origin only).

### Accountability and governance
- **Audit trail:** who, what, when, from which address, and the request id. Permission denials and rejected CSRF or rate-limited requests go to the structured application log (with the same request id). The table is **append-only at the database level** (a trigger rejects `UPDATE` and `DELETE`). Sign-ins, failures, lockouts, password and 2FA changes, exports, prescription overrides, refunds, claim decisions **and every view of a patient record, document or consultation** are recorded.
- **Prescribing safety:** allergy, interaction and dose checks; overriding a blocking finding requires a written reason that is stored and audited.
- **Records:** signed consultations are locked; invoices are corrected by refund records, never edited; stock changes are a ledger.
- **Administration is separate from assessment:** hospital administrators cannot create, modify or promote security-assessor accounts.
- **Local-only maintenance:** database reset and demo-password restore are CLI commands that refuse non-local databases and `NODE_ENV=production`; there is no HTTP endpoint for them.

### Supply chain and delivery
- Production dependencies audited with `npm audit` (0 known vulnerabilities at last check); Dependabot weekly update PRs for npm, GitHub Actions and the Docker base image; CodeQL static analysis (the deliberate lab weaknesses are expected to be reported).
- CI on every push: lint, typecheck, API and unit tests, build, browser tests, and a Docker job that builds the images and checks both modes.
- Containers run as the unprivileged `node` user with all Linux capabilities dropped, `no-new-privileges`, and a process limit. Published ports bind to `127.0.0.1`; the database publishes none.

## Deploying beyond your own machine
The defaults suit a laptop. Before exposing it anywhere:
1. Run **secure mode** only, with `NODE_ENV=production`. Lab mode is refused.
2. Put it behind **HTTPS** (a reverse proxy or tunnel). Keep `COOKIE_SECURE` on (default in production) and set `TRUST_PROXY=1` so rate limits and the audit trail see real client addresses.
3. Build the front end and serve it from the API: `npm run build -w frontend`, then `SERVE_FRONTEND=1 NODE_ENV=production npm start -w backend`.
4. On first start note the one-time passwords printed in the console and change them at first sign-in. Never reuse the development passwords from the README.
5. Use a strong `POSTGRES_PASSWORD` and a managed or encrypted volume for the database and uploads.
6. Keep dependencies current (merge Dependabot PRs) and watch the audit log.

## Known gaps
Stated plainly, because "no flaw" is not a claim anyone can make:
- **No third-party assessment.** Controls are verified by this project's own tests and static analysis only.
- **Breached-password lookup is offline.** The app makes no outbound calls, so it uses a built-in common-password list and pattern rules instead of the Pwned Passwords service.
- **Reset codes are stored in the database in clear text** because the demonstration "mail" outbox shows them to an administrator. A real mail integration should store only a hash.
- **Rate limits are per process** (in memory). With several instances, add a shared limit at the proxy.
- **Data at rest** is not encrypted by the application; use disk or volume encryption. Uploaded files are not virus-scanned.
- **Backups, retention and disaster recovery** are out of scope for this repository.
- **Accessibility** has been checked by automated tests and review, not by a formal audit.
- The five **intentional lab weaknesses** exist by design in lab mode.
