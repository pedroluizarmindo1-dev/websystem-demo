# Phase 4 — Production acceptance and operational hardening

Status: **prepared, not deployed**. The production `/api/health` endpoint still identifies the running application as `1.0.0-rc1`.

## 4.1 Release provenance
- Target GitHub branch: `release/client-build-2026-11-10`.
- Use the exact tested commit SHA when approving production deployment.
- A green CI run is not proof that the same SHA runs on the VPS.
- Do not rename the deployed version to 4.0 without matching the actual deployed artifact.

## 4.2 Application security acceptance
- `APP_ORIGIN` must equal the public first-party HTTPS origin.
- Secure client cookies, same-site restrictions, proxy trust limited to loopback, RBAC and cross-account isolation must pass.
- Admin access must remain IP-restricted; test denied access from an unapproved source.
- Wallet deposit requests remain disabled and no real-money integration is enabled.
- Avoid testing with live client credentials or placing secrets in CI logs.

## 4.3 Database and recovery
- Run SQLite integrity checks for both `websystem.sqlite` and `auth.sqlite`.
- Execute a backup and isolated restore rehearsal before deploying.
- Confirm rollback restores prior application code and removes new-only code files, without deleting data, backups, or secrets.
- Record the rollback log and independently verify public HTTPS health.

## 4.4 Operational verification
- Confirm Hostinger VPS identity before any change.
- Confirm `/api/health` returns HTTP 200 before and after release.
- Validate browser registration, verification, login, order ownership and support flows using designated QA accounts.
- Confirm SMTP configuration and real email delivery separately; static checks cannot prove email delivery.
- Monitor service restarts, 5xx responses and database growth after deployment.

## 4.5 Deferred scope
- PIX gateway/webhook and other payment activation.
- Dynamic order forms and supplier-specific field schemas.

## Phase 4 completion criteria
Phase 4 is complete only when the tested commit is actually deployed, the operational acceptance checks pass, and the deployed version/provenance is recorded. A repository-only milestone remains **release candidate**.
