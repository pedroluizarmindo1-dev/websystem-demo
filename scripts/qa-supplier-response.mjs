import assert from 'node:assert/strict';
import {supplierCall} from '../api/imeive.mjs';
const previous={...process.env};
const originalFetch=globalThis.fetch;
process.env.IMEIVE_API_URL='https://imeiveserver.com/api/index.php';
process.env.IMEIVE_API_USERNAME='test-user';
process.env.IMEIVE_API_KEY='test-key';
try{
 globalThis.fetch=async()=>new Response(JSON.stringify({SUCCESS:[{ok:true}]}),{status:200,headers:{'content-type':'application/json'}});
 assert.deepEqual(await supplierCall('accountinfo'),[{ok:true}]);
 globalThis.fetch=async()=>new Response('not-json',{status:200});
 await assert.rejects(()=>supplierCall('accountinfo'),/não JSON/);
 globalThis.fetch=async()=>new Response('x',{status:200,headers:{'content-length':String(6*1024*1024)}});
 await assert.rejects(()=>supplierCall('accountinfo'),/limite permitido/);
 globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(3*1024*1024));c.enqueue(new Uint8Array(3*1024*1024));c.close()}}),{status:200});
 await assert.rejects(()=>supplierCall('accountinfo'),/limite permitido/);
 console.log('SUPPLIER_RESPONSE_LIMIT_PASS');
}finally{
 globalThis.fetch=originalFetch;
 for(const key of ['IMEIVE_API_URL','IMEIVE_API_USERNAME','IMEIVE_API_KEY']){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key]}
}
