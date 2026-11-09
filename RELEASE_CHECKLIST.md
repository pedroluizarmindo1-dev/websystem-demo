# UNLOCKER TOOLS · Release Candidate 1.0

## Status
**Release candidate, not production-certified.** The public website is a demonstration until the gates below are independently verified.

## What is included
- Responsive login and administrative dashboard, order tracking sublink at `/consulta.html`, customer-specific random tokens.
- Services catalog, orders, tickets, wallet request flow, reseller API subset and supplier synchronization controls.
- Supplier API credentials stored in Render environment variables, not in the repository.
- Web Inspector smoke tests covering mobile, desktop, security boundaries and public tracking.
- Basic HTTP hardening headers and restricted readiness endpoint.

## Blocking release gates
- [ ] Verify supplier authentication with a real read-only account query from the deployed Render service.
- [ ] Verify supplier catalog import and USD currency; verify prices against supplier source before selling.
- [ ] Confirm Render persistent disk or migrate SQLite to durable database. Current `data/` path is local and may be ephemeral across deploys; both application and auth DB must be persisted.
- [ ] Configure production admin account, unique passwords, secrets rotation and recovery procedure.
- [ ] Test authenticated orders end-to-end, including public tracking token generation and revocation.
- [ ] Test actual production checkout/payment and supplier fulfillment before enabling them; they are NOT currently automated.
- [ ] Run Web Inspector against the live deployment after every release.
- [ ] Validate backup/restore, audit logging, monitoring, privacy and incident response.

## Manual verification
```sh
npm ci
npm run build
npm run inspect:web
```
For local smoke tests set `WEB_INSPECT_URL=http://127.0.0.1:3100` and start the built Express server.

## Version policy
Only remove the release-candidate label after the blocking gates are signed off. Do not represent the demo as a live fulfillment/payment platform before validation.
