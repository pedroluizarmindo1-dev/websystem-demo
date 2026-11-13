# Multi-agent development protocol — WebSystem UNLOCKER Tools

## Authority and environment boundaries
- Repository: `pedroluizarmindo1-dev/websystem-demo`
- Integration branch: `release/client-build-2026-11-10`
- Production: Hostinger VPS 2143521, `/opt/websystem`, `https://unlockertools.tech`
- BOX environments are auxiliary; Game Panel 4 VPS 2144007 is unrelated.
- Never treat CI success as proof of production deployment.
- Never deploy directly over SSH. Only approved GitHub Actions workflow_dispatch with deploy=true and production environment approval may deploy.

## Before every task
1. Run `git fetch origin --prune`, `git status --short`, `git rev-parse HEAD`, and `git rev-parse origin/release/client-build-2026-11-10`.
2. Record base SHA, task owner, scope and file list in the PR description.
3. Create a dedicated `agent/<module>-<task>` branch from the latest integration SHA.
4. Preserve uncommitted changes and other agents' work. Never force-push shared branches.
5. Check open PRs for overlapping files and dependent branches before editing.

## Concurrency and integration
- One active owner per shared file at a time, particularly `api/server.mjs`, `api/schema.sql`, `package.json`, `compose.yaml`, and `.github/workflows/*`.
- Split domain work into focused modules and coordinate shared entrypoint changes through one integration PR.
- Before merging, fetch current integration HEAD, compare against recorded base SHA, resolve conflicts, rerun QA.
- Do not merge PRs targeting `main` or intermediate feature branches into integration without inspecting dependency chains and duplicate commits.
- PR review and passing CI are required; a direct push to integration is not an acceptable collaboration workflow.

## Implementation safeguards
- Maintain Node/Express, React/Vite and SQLite compatibility.
- Use backward-compatible migrations and preserve both application and auth databases.
- All protected routes must enforce authorization and tenant isolation.
- Never expose tokens, credentials, IMEI or customer PII in logs or commits.
- Preserve centralized order state machine, financial idempotency and supplier retries.
- Never send live supplier orders or move real money during QA.
- PIX payment webhooks and dynamic supplier-specific order forms are explicitly deferred.

## Quality gates
Run `npm ci`, `npm run build`, `npm audit --omit=dev --audit-level=high`, `node scripts/agents-orchestrator.mjs`, `node scripts/qa-order-transitions.mjs`, and `node scripts/qa-production-release-gates.mjs` plus module-specific QA. CI is authoritative for release readiness.

## PR handoff checklist
- [ ] Task owner and purpose
- [ ] Base integration SHA and final branch SHA
- [ ] Files changed and overlapping PRs reviewed
- [ ] API/schema compatibility reviewed
- [ ] Tests and results documented
- [ ] Security and rollback impact assessed
- [ ] No secrets or customer data committed
- [ ] CI green and integration HEAD rechecked
- [ ] Production status accurately stated

## Definition of done
Merged after review and green CI with documented evidence. Production release is a separate gated process; verify public `/api/health` version and commit after deployment.
