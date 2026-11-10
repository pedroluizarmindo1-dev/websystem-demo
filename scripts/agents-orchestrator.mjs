#!/usr/bin/env node
/**
 * WebSystem six-stage operations orchestrator.
 * Defaults to non-destructive checks; deploy is opt-in and requires a local VPS checkout.
 * No payment activation, no DNS writes, no arbitrary remote command execution.
 */
import {spawnSync} from 'node:child_process';
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const root=resolve(import.meta.dirname,'..');
const args=new Set(process.argv.slice(2));
const deploy=args.has('--deploy');
const report={run_id:randomUUID(),started_at:new Date().toISOString(),mode:deploy?'local-vps-deploy':'preflight',agents:[],release:'client-build-2026-11-10'};
const state={failed:false,deployed:false};
const record=(agent,task,status,detail='')=>{const entry={agent,task,status,detail:String(detail).slice(0,1200),at:new Date().toISOString()};report.agents.push(entry);console.log(JSON.stringify(entry));if(status==='FAIL')state.failed=true;return status==='PASS'};
const run=(cmd,argv,timeout=120000,env={})=>{const p=spawnSync(cmd,argv,{cwd:root,encoding:'utf8',timeout,env:{...process.env,...env,WALLET_REQUESTS_ENABLED:'false'},maxBuffer:1024*1024});if(p.error)throw p.error;if(p.status!==0)throw Error((p.stderr||p.stdout||'exit '+p.status).slice(-1200));return (p.stdout||'ok').trim().slice(-600)};
const attempt=(agent,task,fn,{retry=false}={})=>{try{return record(agent,task,'PASS',fn())}catch(e){if(retry){try{return record(agent,task,'PASS','Recovered on retry: '+fn())}catch(e2){return record(agent,task,'FAIL',e2.message)}}return record(agent,task,'FAIL',e.message)}};
const skip=(agent,task,why)=>record(agent,task,'BLOCKED',why);

try{
  // 1. Architect: requirements and environment assumptions.
  attempt('Arquiteto','release specification',()=>{if(!existsSync(resolve(root,'CLIENT_BUILD_REPORT.md')))throw Error('Missing release specification');return 'documented'});
  attempt('Arquiteto','deployment topology',()=>{const compose=readFileSync(resolve(root,'compose.yaml'),'utf8');if(!compose.includes('127.0.0.1:3100:3100'))throw Error('App port must bind loopback only');return 'reverse proxy -> loopback 3100 -> container 3100'});
  // 2. Inspector: prevent accidental payment enablement, check secrets and config.
  attempt('Code Inspector','wallet feature gate',()=>{const s=readFileSync(resolve(root,'api/wallet.mjs'),'utf8');if(!s.includes("process.env.WALLET_REQUESTS_ENABLED==='true'"))throw Error('Missing opt-in wallet gate');return 'default off'});
  attempt('Code Inspector','tracked source secret patterns',()=>{const files=['api/server.mjs','api/wallet.mjs','api/client-area.mjs','compose.yaml'];for(const file of files){const s=readFileSync(resolve(root,file),'utf8');if(/(?:sk_live_|ghp_)[A-Za-z0-9]{18,}/.test(s))throw Error('Possible hardcoded secret in '+file)}return files.length+' files scanned (heuristic only)'});
  // 3. Executor: compile and validate locally, deploy only with explicit guardrails.
  for(const file of ['api/server.mjs','api/wallet.mjs','api/client-area.mjs'])attempt('Executor','syntax '+file,()=>run('node',['--check',file]));
  attempt('Executor','frontend production build',()=>run('npm',['run','build']),{retry:true});
  // 4. QA: start ephemeral local API and validate critical endpoints without credentials.
  attempt('QA','route and auth smoke tests',()=>{
    const child=spawnSync('node',['scripts/qa-smoke.mjs'],{cwd:root,encoding:'utf8',timeout:45000,env:{...process.env,WALLET_REQUESTS_ENABLED:'false'}});
    if(child.error||child.status!==0)throw Error((child.stderr||child.stdout||child.error?.message||'smoke failure').slice(-1000));
    return child.stdout.trim().slice(-600);
  });
  attempt('QA','isolated authenticated non-admin RBAC',()=>run('node',['scripts/qa-rbac-isolated.mjs'],45000));
  // 5. Debugger: log failed checks, no unreviewed production hotfix.
  const failed=report.agents.filter(x=>x.status==='FAIL');
  record('Debugger','failure triage',failed.length?'BLOCKED':'PASS',failed.length?failed.map(x=>x.task).join(', '):'No failed preflight checks');
  // 6. Web Master: only passive external check; never modify DNS/SSL automatically.
  if(process.env.PUBLIC_BASE_URL){
    attempt('Web Master','public HTTPS health',()=>{const u=new URL(process.env.PUBLIC_BASE_URL);if(u.protocol!=='https:')throw Error('HTTPS required');return 'HTTPS URL configured; live check delegated to ops monitoring'});
  }else skip('Web Master','public HTTPS health','PUBLIC_BASE_URL not set');
  if(deploy){
    if(state.failed||process.env.ALLOW_VPS_DEPLOY!=='true'||process.env.VPS_LOCAL_CHECKOUT!=='true'){
      skip('Executor','Docker deployment','Requires all checks passing, ALLOW_VPS_DEPLOY=true and VPS_LOCAL_CHECKOUT=true');
    }else{
      // Backups must be performed and independently verified before enabling deploy.
      if(process.env.BACKUP_VERIFIED!=='true')skip('Executor','Docker deployment','BACKUP_VERIFIED=true required after verified database backup');
      else attempt('Executor','Docker deployment',()=>{run('docker',['compose','up','-d','--build','--no-deps','websystem'],180000);const status=run('docker',['compose','ps','--status','running','--services'],20000);if(!status.split(/\s+/).includes('websystem'))throw Error('Websystem container not running after deployment');const health=run('docker',['compose','exec','-T','websystem','node','-e',"fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],30000);state.deployed=true;return 'Docker container running; internal health OK '+health});
    }
  }else skip('Executor','Docker deployment','Preflight only; use --deploy with required safety gates on VPS');
  if(!state.deployed)skip('Web Master','publication','No verified deployment in this run');
}catch(e){record('Orchestrator','unexpected failure','FAIL',e.message)}
finally{
  report.finished_at=new Date().toISOString();report.ok=!state.failed;report.deployed=state.deployed;
  mkdirSync(resolve(root,'reports'),{recursive:true});writeFileSync(resolve(root,'reports','agents-latest.json'),JSON.stringify(report,null,2)+'\n');
  console.log('REPORT reports/agents-latest.json');if(state.failed)process.exitCode=1;
}
