// One-time, bounded import of third-party public announcements as NON-ORDERABLE references.
import {DatabaseSync} from 'node:sqlite';
import {syncEntireCatalog} from '../api/telegram-catalog.mjs';
const db=new DatabaseSync(process.env.WEBSYSTEM_DB_PATH||'data/websystem.sqlite');
try{const result=await syncEntireCatalog(db,{maxPages:12});console.log('PUBLIC_REFERENCE_IMPORT',JSON.stringify(result));if(result.error||!result.pages)process.exitCode=1}finally{db.close()}
