const repo=process.env.GITHUB_REPOSITORY||'pedroluizarmindo1-dev/websystem-demo';
const base=process.env.INTEGRATION_BRANCH||'release/client-build-2026-11-10';
const token=process.env.GITHUB_TOKEN||'';
const pr=Number(process.env.PR_NUMBER||0);
if(!/^[-\w.]+\/[-\w.]+$/.test(repo)||!Number.isSafeInteger(pr)||pr<1)throw Error('GITHUB_REPOSITORY and PR_NUMBER required');
async function api(path){
 const response=await fetch('https://api.github.com/repos/'+repo+path,{headers:{Accept:'application/vnd.github+json','User-Agent':'websystem-agent-coordination',...(token?{Authorization:'Bearer '+token}:{})},signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error('GitHub API '+response.status+' '+path);
 return response.json();
}
async function pages(path){
 let out=[];
 for(let page=1;page<=10;page++){
  const items=await api(path+(path.includes('?')?'&':'?')+'per_page=100&page='+page);
  if(!Array.isArray(items))throw Error('Invalid GitHub API pagination');
  out.push(...items);
  if(items.length<100)return out;
 }
 throw Error('Pagination limit reached');
}
const current=await api('/pulls/'+pr);
if(current.base.ref!==base)throw Error('PR targets '+current.base.ref+'; expected '+base);
const integration=await api('/branches/'+encodeURIComponent(base));
const comparison=await api('/compare/'+encodeURIComponent(base)+'...'+encodeURIComponent(current.head.sha));
const behind=Number(comparison.behind_by||0);
const mine=new Set((await pages('/pulls/'+pr+'/files')).map(f=>f.filename));
const open=await pages('/pulls?state=open');
const overlaps=[];
for(const other of open){
 if(other.number===pr||other.base.ref!==base)continue;
 const files=(await pages('/pulls/'+other.number+'/files')).map(f=>f.filename);
 const shared=files.filter(f=>mine.has(f));
 if(shared.length)overlaps.push({pr:other.number,files:shared});
}
console.log(JSON.stringify({pr,base_sha:integration.commit.sha,head_sha:current.head.sha,behind_by:behind,files:[...mine],overlaps},null,2));
if(behind>0){console.error('STALE_INTEGRATION_BASE: rebase or merge current integration branch and rerun QA');process.exitCode=1}
if(overlaps.length)console.warn('SHARED_FILE_OVERLAP: coordinate before merge');
