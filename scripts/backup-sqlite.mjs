import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,chmodSync,readdirSync,unlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
const data=resolve(process.env.DATA_DIR||'./data');
const dest=resolve(process.env.BACKUP_DIR||'./backups');
mkdirSync(dest,{recursive:true,mode:0o700});chmodSync(dest,0o700);
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
for(const name of ['websystem.sqlite','auth.sqlite']){
 const src=join(data,name),target=join(dest,name+'.'+stamp+'.bak');
 const db=new DatabaseSync(src,{readOnly:true});
 try{
  await backup(db,target);
  chmodSync(target,0o600);
  const check=new DatabaseSync(target,{readOnly:true});
  try{if(check.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw Error('Integrity check failed: '+name)}
  finally{check.close()}
  console.log('Backup verified:',target);
 }finally{db.close()}
 const files=readdirSync(dest).filter(f=>f.startsWith(name+'.')&&f.endsWith('.bak')).sort().reverse();
 for(const old of files.slice(14))unlinkSync(join(dest,old));
}
