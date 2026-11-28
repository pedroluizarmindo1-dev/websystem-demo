import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const compose=readFileSync('compose.yaml','utf8');
const dockerfile=readFileSync('Dockerfile','utf8');
const server=readFileSync('api/server.mjs','utf8');
const deploy=readFileSync('scripts/deploy-hostinger.sh','utf8');
const predeploy=readFileSync('scripts/predeploy-hostinger.sh','utf8');
const workflow=readFileSync('.github/workflows/hostinger-release.yml','utf8');
assert.match(compose,/APP_ORIGIN:\s*\$\{APP_ORIGIN:-https:\/\/unlockertools\.tech\}/);
assert.match(server,/origin!==process\.env\.APP_ORIGIN/);
assert.match(predeploy,/HOST_IDENTITY_OK/);
assert.match(predeploy,/HOST_IDENTITY_MISMATCH[\\s\\S]*exit 1/);
assert.ok(predeploy.indexOf('HOST_IDENTITY_OK')<predeploy.indexOf('execute-backup'),'preflight must verify host before backup');
assert.match(deploy,/DEPLOY_HOST_IDENTITY_OK/);
assert.match(deploy,/DEPLOY_HOST_IDENTITY_MISMATCH[\\s\\S]*exit 1/);
assert.ok(deploy.indexOf('DEPLOY_HOST_IDENTITY_OK')<deploy.indexOf('"$BACKUP_CMD"'),'deploy must verify host before backup');
assert.match(deploy,/DEPLOY_BACKUP_OK/);
assert.match(deploy,/DEPLOY_ARCHIVE_VALIDATED/);
assert.match(deploy,/rsync -a --checksum/);
assert.match(workflow,/if:\s*github\.event_name == 'workflow_dispatch' && inputs\.deploy == true && github\.ref == 'refs\/heads\/release\/client-build-2026-11-10'/);
assert.match(workflow,/environment: production/);
assert.match(workflow,/node scripts\/qa-production-release-gates\.mjs/);
assert.match(deploy,/DEPLOY_PUBLIC_HEALTH_OK/);
assert.match(deploy,/rsync -a --checksum --delete/);
assert.match(deploy,/trap rollback ERR/);
assert.match(compose,/127\.0\.0\.1:3100:3100/);
assert.match(compose,/COOKIE_SECURE:\s*"true"/);
// Forwarded client IPs: only our own reverse proxy is trusted (TRUST_PROXY); trust-everything values never start the server.
assert.match(server,/app\.set\('trust proxy',resolveTrustProxy\(process\.env\.TRUST_PROXY\)\)/);
const {resolveTrustProxy}=await import('../api/proxy-trust.mjs');
assert.deepEqual(resolveTrustProxy(undefined),['loopback']);
for(const unsafe of ['true','1','*','0.0.0.0/0','::/0'])assert.throws(()=>resolveTrustProxy(unsafe));
assert.match(compose,/TRUST_PROXY:\s*\$\{TRUST_PROXY:-loopback,uniquelocal\}/);
assert.match(compose,/-\s*"127\.0\.0\.1:3100:3100"/); // private peers are trusted only while the port stays on loopback
assert.match(server,/origin!==process\.env\.APP_ORIGIN/);
assert.ok(deploy.includes('release-manifest.json'));
assert.ok(workflow.includes('release-manifest.json'));
assert.ok(server.includes('release-manifest.json'));
assert.ok(server.includes('commit:manifest.commit'));
assert.match(dockerfile,/COPY --from=build \/app\/release-manifest\.json \.\/release-manifest\.json/);
assert.ok(deploy.includes('Public release provenance mismatch'));
assert.ok(deploy.includes('EXPECTED_SHA='));
assert.ok(deploy.indexOf('DEPLOY_PUBLIC_HEALTH_OK')<deploy.indexOf('trap - ERR'));
for(const wf of ['.github/workflows/hostinger-docker-staging.yml','.github/workflows/container-build.yml']){
 const text=readFileSync(wf,'utf8');
 const m=text.indexOf('release-manifest.json'),b=text.search(/docker build/);
 assert.ok(m>-1&&b>-1&&m<b,wf+' must generate release-manifest.json before docker build');
}
console.log('PRODUCTION_RELEASE_GATES_PASS');
