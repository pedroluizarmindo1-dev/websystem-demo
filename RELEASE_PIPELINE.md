# WebSystem release pipeline

Run `node scripts/release-pipeline.mjs` on a checked-out copy of this release branch. The script executes planning/documentation checks, static security gates, syntax validation and production frontend build; writes `reports/pipeline-latest.json`.

**Safety:** this is a preflight orchestrator, not six independently deployed autonomous services. It does not run SSH, change DNS, deploy Docker containers, modify production databases, enable payments, or claim a successful production release. The final deploy gate stays blocked until authenticated functional QA, backup/restore and security review pass.

Roles: Arquiteto → Code Inspector → Executor (build-only) → QA → Debugger (on failure) → Web Master (blocked pending production gates).
