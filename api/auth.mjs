import {randomBytes,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {mkdirSync} from 'node:fs';
const dir=resolve(import.meta.dirname,'../data');mkdirSync(dir,{recursive:true});
export const authdb=new DatabaseSync(resolve(dir,'auth.sqlite'));
authdb.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'admin',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);`);
export function hashPassword(p,salt=randomBytes(24).toString('hex')){return {salt,hash:scryptSync(p,salt,64).toString('hex')}}
export function createUser(username,password){if(password.length<16)throw Error('Minimum 16 characters');const h=hashPassword(password);authdb.prepare('INSERT INTO users(username,password_salt,password_hash) VALUES (?,?,?)').run(username,h.salt,h.hash)}
export function verify(username,password){const u=authdb.prepare('SELECT * FROM users WHERE username=?').get(username);if(!u)return null;const actual=scryptSync(password,u.password_salt,64);const expected=Buffer.from(u.password_hash,'hex');return timingSafeEqual(actual,expected)?u:null}
const digest=s=>createHash('sha256').update(s).digest('hex');
export function issue(user){const token=randomBytes(32).toString('hex');authdb.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(digest(token),user.id,Date.now()+8*3600000);return token}
export function getSession(token){if(!token)return null;return authdb.prepare('SELECT users.id,users.username,users.role FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?').get(digest(token),Date.now())||null}
export function revoke(token){if(token)authdb.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token))}