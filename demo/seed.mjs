import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {readFileSync,mkdirSync} from 'node:fs';
import {createUser,authdb} from '../api/auth.mjs';
const root=resolve(import.meta.dirname,'..');mkdirSync(resolve(root,'data'),{recursive:true});
const db=new DatabaseSync(resolve(root,'data/websystem.sqlite'));
db.exec(readFileSync(resolve(root,'api/schema.sql'),'utf8'));
if(process.env.DEMO_MODE!=='true')process.exit(0);
const user=process.env.DEMO_USERNAME||'demo';
const pass=process.env.DEMO_PASSWORD;
if(!pass||pass.length<16)throw Error('Set DEMO_PASSWORD (at least 16 chars) as a Render secret');
if(!authdb.prepare('SELECT id FROM users WHERE username=?').get(user))createUser(user,pass);
if(db.prepare('SELECT COUNT(*) n FROM services').get().n===0){
const services=[['Samsung Galaxy S24 — FRP (demonstração)','Unlocks','Samsung','Galaxy S24',18],['Motorola Edge 50 — Serviço remoto (demonstração)','Remote Tools','Motorola','Edge 50',25],['OPPO Reno 13 — Diagnóstico (demonstração)','Server Services','OPPO','Reno 13',12],['iPhone — Consulta de status (demonstração)','IMEI','Apple','iPhone',5]];
const insert=db.prepare('INSERT INTO services(source,name,category,brand,model,price_usd,available) VALUES (?,?,?,?,?,?,?)');
for(const [name,category,brand,model,price] of services)insert.run('demo',name,category,brand,model,price,1);
db.prepare('INSERT INTO exchange_rates(base,quote,rate,provider) VALUES (?,?,?,?)').run('USD','BRL',5.00,'demo-ficticio');
const order=db.prepare('INSERT INTO orders(customer_name,customer_contact,device_brand,device_model,service_id,price_brl,anydesk_id) VALUES (?,?,?,?,?,?,?)');
order.run('Cliente Exemplo','teste@example.invalid','Samsung','Galaxy S24',1,108,'DEMO-000000');
}
console.log('Demo seed ready (synthetic data only)');
