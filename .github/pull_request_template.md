## Summary
<!-- What changed and why? -->

## Multi-agent coordination
- Agent / task owner:
- Integration base SHA (`release/client-build-2026-11-10`):
- Final branch SHA:
- Files owned / modified:
- Other active PRs checked:
- Shared-file coordination / dependency:

## Verification
- [ ] Fetched latest integration HEAD before work
- [ ] Compared branch against latest integration HEAD before review
- [ ] `npm ci`
- [ ] `npm run build`
- [ ] `npm audit --omit=dev --audit-level=high`
- [ ] `node scripts/agents-orchestrator.mjs`
- [ ] `node scripts/qa-order-transitions.mjs`
- [ ] `node scripts/qa-production-release-gates.mjs`
- [ ] Module-specific QA documented
- [ ] No secrets, PII, or live supplier orders in QA

## API, database and security impact
<!-- Include migrations, backwards compatibility, authorization and rollback. -->

## Deployment
- [ ] No direct SSH deployment
- [ ] Production is NOT claimed updated merely from CI success
- [ ] Protected workflow and approval required for release
