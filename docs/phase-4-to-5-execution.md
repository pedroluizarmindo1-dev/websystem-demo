# Phase 4 → 5: operational acceptance and service readiness

## Confirmed in source
- Guarded deployment workflow, backup gate, rollback rehearsal and isolated quality checks.
- APP_ORIGIN and secure cookie defaults in Docker Compose.
- Release archive now includes release-manifest.json with the exact workflow SHA.
- /api/health reports release version and commit only when the manifest is valid.
- Payment requests and dynamic supplier-specific forms remain deferred.

## Remaining production actions (not performed by source commits)
1. Re-run Hostinger predeploy and isolated restore on the UNLOCKERTOOLS VPS; preserve logs and backup references.
2. Approve and dispatch guarded production workflow with deploy=true and the tested SHA.
3. Confirm public /api/health returns the same SHA, version and HTTP 200; inspect Docker health.
4. Verify two independent QA client accounts: signup, verification, login, order isolation, support, logout, password reset.
5. Verify actual outbound mail and error handling using QA mailboxes.
6. Review 5xx, latency, rate-limit responses and database integrity after release.
7. Only after verified deployment, promote version labels and declare the production release.

## Phase 5 implementation queue
- Supplier catalog reconciliation, error handling and idempotent DHRU order submission (no real-money orders during QA).
- Order state machine with authorized transitions and safe retries.
- Read-only client order timeline and support event history.
- Operational audit dashboard and error reporting with no credentials in logs.
- Defer PIX payment provider/webhooks and dynamic order forms until the final scheduled stage.

## Explicit safety boundary
Do not claim Phase 5 live from passing repository CI. Avoid real customer orders, payment activation and direct DB mutations during acceptance testing.
