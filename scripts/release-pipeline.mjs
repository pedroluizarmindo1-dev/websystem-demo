#!/usr/bin/env node
// WebSystem release pipeline: read-only preflight. No deployment or payment activation.
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const checks=[];
function check(agent,name,fn){try{const detail=fn();checks.push({agent,name,status:'PASS',detail:String(detail||'ok')})}catch(e){checks.push({agent,name,status:'FAIL',detail:String(e.message||e)})}}
function command(agent,name,cmd,args){check(agent,name,()=>{const p=spawnSync(cmd,args,{cwd:root,encoding:'utf8',timeout:120000,env:{...process.env,WALLET_REQUESTS_ENABLED:'false'}});if(p.error)throw p.error;if(p.status!==0)throw Error((p.stderr||p.stdout||'exit '+p.status).slice(-800));return (p.stdout||'ok').trim().slice(-200)})}
check('Arquiteto','release documentation',()=>{if(!existsSync(resolve(root,'CLIENT_BUILD_REPORT.md')))throw Error('Missing release report');return 'release scope documented'});
check('Code Inspector','wallet safe default',()=>{const s=readFileSync(resolve(root,'api/wallet.mjs'),'utf8');if(!s.includes("process.env.WALLET_REQUESTS_ENABLED==='true'"))throw Error('Wallet feature gate missing');return 'requests require explicit opt-in'});
check('Code Inspector','no payment credentials in pipeline',()=>{const s=readFileSync(new URL(import.meta.url),'utf8');if(/PRIVATE_KEY\s*=|SMTP_PASS\s*=/.test(s))throw Error('Credential assignment found');return 'no embedded secrets detected in pipeline'});
command('Implantação','server syntax','node',['--check','api/server.mjs']);
command('Implantação','wallet syntax','node',['--check','api/wallet.mjs']);
command('QA','client module syntax','node',['--check','api/client-area.mjs']);
command('QA','production frontend build','npm',['run','build']);
const failed=checks.filter(x=>x.status==='FAIL');
checks.push({agent:'Debugger',name:'automatic recovery',status:failed.length?'PENDING':'NOT_REQUIRED',detail:failed.length?'Investigate failed checks before deployment':'No failed checks'});
checks.push({agent:'Web Master',name:'production publish',status:'BLOCKED',detail:'Requires VPS preflight, backups, authenticated QA and explicit release gates; no production changes performed'});
const report={generated_at:new Date().toISOString(),release:'client-build-2026-11-10',safe_mode:true,payments_enabled:false,checks};
mkdirSync(resolve(root,'reports'),{recursive:true});
const output=resolve(root,'reports','pipeline-latest.json');writeFileSync(output,JSON.stringify(report,null,2)+'\n');
for(const x of checks)console.log(x.status.padEnd(12),x.agent.padEnd(16),x.name,'-',x.detail);
console.log('Report:',output);process.exitCode=failed.length?1:0;
