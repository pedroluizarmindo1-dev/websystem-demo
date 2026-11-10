import {randomBytes,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import {Router} from 'express';
import nodemailer from 'nodemailer';

const digest=s=>createHash('sha256').update(s).digest('hex');
const validEmail=s=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)&&s.length<=254;
const fail=(res,code,msg)=>res.status(code).json({error:msg});
const safePassword=p=>typeof p==='string'&&p.length>=16&&p.length<=256;
const cookie=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(v=>v.length===2));
const tokenKey='ws_client';
const secureCookie=(req,token,maxAge)=>tokenKey+'='+token+'; HttpOnly; SameSite=Lax; Path=/api/client; Max-Age='+maxAge+(process.env.COOKIE_SECURE==='true'?'; Secure':'');
const hashPassword=(password,salt)=>scryptSync(password,salt,64).toString('hex');
const mailReady=()=>['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','MAIL_FROM'].every(k=>process.env[k]);
const transport=()=>nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT),secure:Number(process.env.SMTP_PORT)===465,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS},requireTLS:Number(process.env.SMTP_PORT)!==465,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000});
export function mountClientArea(app,db,{adminGuard}){
 db.exec(`CREATE TABLE IF NOT EXISTS client_users(
 id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 display_name TEXT NOT NULL, password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS client_sessions(
 token_hash TEXT PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES client_users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS client_order_links(
 client_id INTEGER NOT NULL REFERENCES client_users(id) ON DELETE CASCADE,
 order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
 PRIMARY KEY(client_id,order_id));
 CREATE TABLE IF NOT EXISTS client_ticket_links(
 client_id INTEGER NOT NULL REFERENCES client_users(id) ON DELETE CASCADE,
 ticket_id INTEGER NOT NULL UNIQUE REFERENCES support_tickets(id) ON DELETE CASCADE,
 PRIMARY KEY(client_id,ticket_id));
 CREATE TABLE IF NOT EXISTS mail_outbox(
 id INTEGER PRIMARY KEY,recipient TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,sent_at TEXT);
 CREATE INDEX IF NOT EXISTS idx_client_sessions_exp ON client_sessions(expires_at);
 CREATE INDEX IF NOT EXISTS idx_mail_outbox_status ON mail_outbox(status,id);`);
 db.exec(`CREATE TABLE IF NOT EXISTS client_auth_tokens(
 token_hash TEXT PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES client_users(id) ON DELETE CASCADE,
 purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset')),expires_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_client_auth_tokens_exp ON client_auth_tokens(expires_at);`);
 db.exec(`CREATE TABLE IF NOT EXISTS client_security_events(id INTEGER PRIMARY KEY,client_id INTEGER,action TEXT NOT NULL,outcome TEXT NOT NULL,ip TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
 const event=(id,action,outcome,req)=>{try{db.prepare('INSERT INTO client_security_events(client_id,action,outcome,ip) VALUES (?,?,?,?)').run(id||null,action,outcome,String(req.ip||'unknown').slice(0,90))}catch(e){console.error('Client audit write failed:',e.message)}};
 const q=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args),run=(sql,...args)=>db.prepare(sql).run(...args);
 const router=Router();
 const originGuard=(req,res,next)=>{if(!['GET','HEAD','OPTIONS'].includes(req.method)){const origin=req.headers.origin;const expected=process.env.APP_ORIGIN;if(!expected||origin!==expected)return fail(res,403,'Origem não autorizada')}next()};
 router.use(originGuard);
 router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');next()});
 const sessions=req=>{const t=cookie(req)[tokenKey];if(!t||!/^[a-f0-9]{64}$/.test(t))return null;return q('SELECT u.id,u.email,u.display_name FROM client_sessions s JOIN client_users u ON u.id=s.client_id WHERE s.token_hash=? AND s.expires_at>? AND u.enabled=1',digest(t),Date.now())};
 const requireClient=(req,res,next)=>{const u=sessions(req);if(!u)return fail(res,401,'Autenticação necessária');req.client=u;next()};
 const flowLimits=new Map();
 const limited=(name,max,windowMs)=>(req,res,next)=>{const now=Date.now(),key=name+':'+req.ip;let x=flowLimits.get(key);if(!x||x.until<now)x={n:0,until:now+windowMs};flowLimits.set(key,x);if(x.n++>=max)return fail(res,429,'Aguarde antes de tentar novamente');if(flowLimits.size>5000)for(const [k,v] of flowLimits)if(v.until<now)flowLimits.delete(k);next()};
 const mail=(to,subject,body)=>transport().sendMail({from:process.env.MAIL_FROM,to,subject,text:body});
 const makeToken=(id,purpose)=>{const token=randomBytes(32).toString('hex');run('DELETE FROM client_auth_tokens WHERE client_id=? AND purpose=?',id,purpose);run('INSERT INTO client_auth_tokens(token_hash,client_id,purpose,expires_at) VALUES (?,?,?,?)',digest(token),id,purpose,Date.now()+30*60000);return token};
 router.post('/register',limited('register',5,3600000),async(req,res)=>{
  if(!mailReady())return fail(res,503,'Cadastro indisponível temporariamente');
  const email=String(req.body?.email||'').trim().toLowerCase(),name=String(req.body?.display_name||'').trim(),password=req.body?.password;
  if(!validEmail(email)||!name||name.length>120||!safePassword(password))return fail(res,400,'Informe nome, e-mail e senha de pelo menos 16 caracteres');
  const old=q('SELECT id,enabled FROM client_users WHERE email=?',email);
  if(old?.enabled)return res.json({ok:true,message:'Se o cadastro puder ser realizado, você receberá um e-mail'});
  const salt=randomBytes(24).toString('hex');let id;
  if(old){id=old.id;run('UPDATE client_users SET display_name=?,password_salt=?,password_hash=? WHERE id=? AND enabled=0',name,salt,hashPassword(password,salt),id)}
  else id=Number(run('INSERT INTO client_users(email,display_name,password_salt,password_hash,enabled) VALUES (?,?,?,?,0)',email,name,salt,hashPassword(password,salt)).lastInsertRowid);
  const token=makeToken(id,'verify');
  try{await mail(email,'Confirme sua conta UNLOCKER Tools',`Para confirmar seu cadastro, acesse: ${process.env.APP_ORIGIN}/client/?view=verify&token=${token}\nEste link expira em 30 minutos.`)}
  catch(e){console.error('Registration email failed');return fail(res,503,'Não foi possível enviar o e-mail. Tente mais tarde')}
  event(id,'client_register','pending_verification',req);res.status(202).json({ok:true,message:'Confira seu e-mail para confirmar a conta'});
 });
 router.post('/verify-email',limited('verify',12,900000),(req,res)=>{
  const token=String(req.body?.token||'');if(!/^[a-f0-9]{64}$/.test(token))return fail(res,400,'Link inválido');
  const row=q("SELECT client_id FROM client_auth_tokens WHERE token_hash=? AND purpose='verify' AND expires_at>?",digest(token),Date.now());
  if(!row)return fail(res,400,'Link inválido ou expirado');
  db.exec('BEGIN IMMEDIATE');try{run('UPDATE client_users SET enabled=1 WHERE id=?',row.client_id);run('DELETE FROM client_auth_tokens WHERE client_id=?',row.client_id);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
  event(row.client_id,'client_verify','success',req);res.json({ok:true});
 });
 router.post('/forgot-password',limited('forgot',5,3600000),async(req,res)=>{
  if(!mailReady())return fail(res,503,'Recuperação indisponível temporariamente');
  const email=String(req.body?.email||'').trim().toLowerCase();if(!validEmail(email))return fail(res,400,'E-mail inválido');
  const u=q('SELECT id FROM client_users WHERE email=? AND enabled=1',email);
  if(u){const token=makeToken(u.id,'reset');try{await mail(email,'Recuperação de senha UNLOCKER Tools',`Para definir uma nova senha, acesse: ${process.env.APP_ORIGIN}/client/?view=reset&token=${token}\nEste link expira em 30 minutos.`)}catch(e){console.error('Password reset email failed')}}
  res.json({ok:true,message:'Se existir uma conta, enviaremos instruções ao e-mail cadastrado'});
 });
 router.post('/reset-password',limited('reset',8,900000),(req,res)=>{
  const token=String(req.body?.token||''),password=req.body?.password;
  if(!/^[a-f0-9]{64}$/.test(token)||!safePassword(password))return fail(res,400,'Link inválido ou senha com menos de 16 caracteres');
  const row=q("SELECT client_id FROM client_auth_tokens WHERE token_hash=? AND purpose='reset' AND expires_at>?",digest(token),Date.now());
  if(!row)return fail(res,400,'Link inválido ou expirado');
  const salt=randomBytes(24).toString('hex');db.exec('BEGIN IMMEDIATE');try{run('UPDATE client_users SET password_salt=?,password_hash=? WHERE id=?',salt,hashPassword(password,salt),row.client_id);run('DELETE FROM client_auth_tokens WHERE client_id=?',row.client_id);run('DELETE FROM client_sessions WHERE client_id=?',row.client_id);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
  event(row.client_id,'client_password_reset','success',req);res.json({ok:true});
 });
 const attempts=new Map();
 router.post('/login',limited('login',25,900000),(req,res)=>{
  const email=String(req.body?.email||'').trim().toLowerCase(),password=req.body?.password;
  const ip=req.ip||req.socket.remoteAddress||'unknown',now=Date.now(),entry=attempts.get(ip)||{n:0,until:0};
  if(entry.until>now){event(null,'client_login','rate_limited',req);return fail(res,429,'Tente novamente mais tarde')}
  if(!validEmail(email)||typeof password!=='string'||password.length>256)return fail(res,401,'Credenciais inválidas');
  const u=q('SELECT * FROM client_users WHERE email=? AND enabled=1',email);
  const salt=u?.password_salt||'00000000000000000000000000000000';
  const expected=Buffer.from(u?.password_hash||hashPassword('dummy-password-not-valid',salt),'hex');
  const actual=scryptSync(password,salt,64);
  if(!u||expected.length!==actual.length||!timingSafeEqual(actual,expected)){
   entry.n++;if(entry.n>=5){entry.n=0;entry.until=now+15*60*1000}attempts.set(ip,entry);event(u?.id||null,'client_login','denied',req);
   return fail(res,401,'Credenciais inválidas');
  }
  attempts.delete(ip);event(u.id,'client_login','success',req);const token=randomBytes(32).toString('hex');
  run('INSERT INTO client_sessions(token_hash,client_id,expires_at) VALUES (?,?,?)',digest(token),u.id,Date.now()+8*3600000);
  res.setHeader('Set-Cookie',secureCookie(req,token,28800));res.json({id:u.id,email:u.email,display_name:u.display_name});
 });
 router.post('/logout',(req,res)=>{const u=sessions(req);if(u)event(u.id,'client_logout','success',req);const t=cookie(req)[tokenKey];if(t)run('DELETE FROM client_sessions WHERE token_hash=?',digest(t));res.setHeader('Set-Cookie',secureCookie(req,'',0));res.json({ok:true})});
 router.get('/me',requireClient,(req,res)=>res.json(req.client));
 router.get('/orders',requireClient,(req,res)=>res.json(all(`SELECT o.id,o.device_brand,o.device_model,o.status,o.payment_status,o.created_at,o.updated_at FROM orders o JOIN client_order_links l ON l.order_id=o.id WHERE l.client_id=? ORDER BY o.id DESC LIMIT 100`,req.client.id)));
 router.get('/tickets',requireClient,(req,res)=>res.json(all(`SELECT t.id,t.order_id,t.subject,t.description,t.status,t.resolution,t.created_at,t.updated_at FROM support_tickets t JOIN client_ticket_links l ON l.ticket_id=t.id WHERE l.client_id=? ORDER BY t.id DESC LIMIT 100`,req.client.id)));
 router.post('/tickets',requireClient,(req,res)=>{
  const subject=String(req.body?.subject||'').trim(),description=String(req.body?.description||'').trim();
  const orderId=req.body?.order_id==null?null:Number(req.body.order_id);
  if(!subject||subject.length>160||!description||description.length>4000)return fail(res,400,'Dados inválidos');
  if(orderId!==null&&(!Number.isSafeInteger(orderId)||!q('SELECT 1 FROM client_order_links WHERE client_id=? AND order_id=?',req.client.id,orderId)))return fail(res,403,'Pedido não autorizado');
  db.exec('BEGIN IMMEDIATE');
  try{
   const r=run('INSERT INTO support_tickets(order_id,subject,description) VALUES (?,?,?)',orderId,subject,description);
   run('INSERT INTO client_ticket_links(client_id,ticket_id) VALUES (?,?)',req.client.id,Number(r.lastInsertRowid));
   db.exec('COMMIT');event(req.client.id,'client_ticket_create','success',req);res.status(201).json({id:Number(r.lastInsertRowid),status:'open'});
  }catch(e){db.exec('ROLLBACK');return fail(res,500,'Não foi possível criar o chamado')}
 });
 app.use('/api/client',router);
 const admin=Router();admin.use(originGuard);admin.use(adminGuard,(req,res,next)=>req.user.role==='admin'?next():fail(res,403,'Acesso restrito'));
 admin.post('/users',(req,res)=>{
  const email=String(req.body?.email||'').trim().toLowerCase(),name=String(req.body?.display_name||'').trim(),password=req.body?.password;
  if(!validEmail(email)||!name||name.length>120||!safePassword(password))return fail(res,400,'E-mail, nome e senha de 16 a 256 caracteres obrigatórios');
  const salt=randomBytes(24).toString('hex');
  try{const r=run('INSERT INTO client_users(email,display_name,password_salt,password_hash) VALUES (?,?,?,?)',email,name,salt,hashPassword(password,salt));event(null,'admin_client_create','success',req);res.status(201).json({id:Number(r.lastInsertRowid),email})}
  catch(e){return fail(res,409,'E-mail já cadastrado')}
 });
 admin.post('/users/:id/orders',(req,res)=>{
  const uid=Number(req.params.id),oid=Number(req.body?.order_id);
  if(!Number.isSafeInteger(uid)||!Number.isSafeInteger(oid)||!q('SELECT id FROM client_users WHERE id=?',uid)||!q('SELECT id FROM orders WHERE id=?',oid))return fail(res,404,'Cliente ou pedido não encontrado');
  try{run('INSERT INTO client_order_links(client_id,order_id) VALUES (?,?)',uid,oid);event(uid,'admin_order_link','success',req);res.status(201).json({ok:true})}catch{return fail(res,409,'Pedido já vinculado')}
 });
 admin.post('/mail/queue',(req,res)=>{
  const recipient=String(req.body?.recipient||'').trim(),subject=String(req.body?.subject||'').trim(),body=String(req.body?.body||'').trim();
  if(!validEmail(recipient)||!subject||subject.length>180||!body||body.length>10000)return fail(res,400,'Mensagem inválida');
  const r=run('INSERT INTO mail_outbox(recipient,subject,body) VALUES (?,?,?)',recipient,subject,body);
  event(null,'admin_mail_queue','success',req);res.status(201).json({id:Number(r.lastInsertRowid),status:'pending'});
 });
 admin.get('/mail/status',(req,res)=>res.json({configured:!!mailReady(),counts:all('SELECT status,COUNT(*) AS count FROM mail_outbox GROUP BY status')}));
 let sending=false;
 admin.post('/mail/send-pending',async(req,res)=>{
  if(sending)return fail(res,409,'Envio em andamento');
  sending=true;
  try{
  if(!mailReady())return fail(res,503,'SMTP não configurado');
  const rows=all("SELECT * FROM mail_outbox WHERE status='pending' AND attempts<3 ORDER BY id LIMIT 10");
  const tx=transport();let sent=0,failed=0;
  for(const m of rows){
   run("UPDATE mail_outbox SET status='sending',attempts=attempts+1 WHERE id=? AND status='pending'",m.id);
   try{await tx.sendMail({from:process.env.MAIL_FROM,to:m.recipient,subject:m.subject,text:m.body});run("UPDATE mail_outbox SET status='sent',sent_at=CURRENT_TIMESTAMP,last_error=NULL WHERE id=?",m.id);sent++}
   catch(e){run("UPDATE mail_outbox SET status='pending',last_error=? WHERE id=?",String(e.message).slice(0,300),m.id);failed++}
  }
  res.json({sent,failed});
  }finally{sending=false}
 });
 app.use('/api/admin/client-area',admin);
}
