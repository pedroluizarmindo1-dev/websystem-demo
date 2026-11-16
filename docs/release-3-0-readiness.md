# WebSystem UNLOCKER Tools — Release 3.0 readiness

## Scope and boundaries
- Included: client area, order history, access controls, SQLite backup/isolated restore, guarded deployment and rollback.
- Deferred: PIX/payment provider integration and dynamic order forms.
- Production deployment is **not** implied by a merge or a passing CI run.
- Current API health version string remains `1.0.0-rc1`; do not claim a Final Release until the running image is verified and the release version is explicitly updated.

## Gates before production
1. Release branch QA succeeds (dependency audit, six-agent tests, deployment syntax, rollback rehearsal, release safety assertions).
2. Hostinger predeploy confirms `PREFLIGHT_PASS`, `BACKUP_COMMAND_OK`, both `SQLITE_INTEGRITY_OK`, and isolated restore for both SQLite databases.
3. Validate the target is the UNLOCKERTOOLS VPS, not the unrelated Game Panel 4 VPS.
4. Verify the running application has `APP_ORIGIN=https://unlockertools.tech` and does not enable real-money wallet requests.
5. Trigger `hostinger-release.yml` manually with `deploy=true`, after review of the target SHA and production environment approval.
6. Require `DEPLOY_BACKUP_OK`, `DEPLOY_ARCHIVE_VALIDATED`, `DEPLOY_PUBLIC_HEALTH_OK`, and `DEPLOY_SUCCESS` in the deployment log.
7. Verify public HTTPS health, authenticated client login, own-order visibility, cross-account denial, and SQLite integrity without altering real orders.
8. On failure, preserve logs and verify rollback health; do not blindly restore a stale database over production.

## Current release status
- Release branch merged from PR #4; deployment remains a separate action.
- Automated quality gates are necessary but not sufficient to declare version 3.0 live.
- The version label must be promoted only after actual production verification.
