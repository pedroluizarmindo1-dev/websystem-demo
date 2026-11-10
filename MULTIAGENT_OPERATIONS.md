# Multiagent Operations — WebSystem

Run `node scripts/agents-orchestrator.mjs` for the complete **safe preflight**. JSON logs are written to `reports/agents-latest.json`.

## Agents and responsibilities
1. **Arquiteto** — validates release specification and deployment topology.
2. **Code Inspector** — validates payment feature gate and performs limited secret-pattern checks (not a complete security audit).
3. **Executor** — validates server modules, builds the frontend, and offers guarded local Docker deployment.
4. **QA** — starts an isolated local API and checks nine public/authentication/404 HTTP responses.
5. **Debugger** — aggregates failed tasks for investigation. It does not automatically patch production.
6. **Web Master** — verifies that an HTTPS URL is configured; publication remains blocked until deploy is verified.

## Deployment requirements
On the **actual Hostinger VPS**, after independently verified database backup and rollback preparation, run only when the release has passed authenticated QA and security review:

```sh
ALLOW_VPS_DEPLOY=true VPS_LOCAL_CHECKOUT=true BACKUP_VERIFIED=true node scripts/agents-orchestrator.mjs --deploy
```

The orchestrator invokes `docker compose up -d --build --no-deps websystem` when gates pass. This command alone does **not** validate a successful deployment, so verify the container health and public HTTPS routes separately before declaring production ready. The current implementation does not automatically configure DNS, certificates, Nginx, or rollback.

**Never set** `WALLET_REQUESTS_ENABLED=true` for this build. Real payments require separate integration and financial QA.

This is a scripted six-stage workflow, **not** six independent always-on agents.
