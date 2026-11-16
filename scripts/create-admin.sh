#!/usr/bin/env bash
set -euo pipefail
cd /opt/websystem
if ! [ -t 0 ]; then echo 'Execute em um terminal interativo.' >&2; exit 1; fi
if ! docker inspect websystem-websystem-1 --format '{{.State.Running}}' | grep -qx true; then echo 'Contêiner indisponível.' >&2; exit 1; fi
count=$(docker exec websystem-websystem-1 node --input-type=module -e 'import {DatabaseSync} from "node:sqlite";const d=new DatabaseSync("/app/data/auth.sqlite",{readOnly:true});console.log(d.prepare("SELECT count(*) n FROM users").get().n);d.close()')
if [ "$count" != 0 ]; then echo "Existem $count usuários. Não alterei nenhuma conta; solicite redefinição específica."; exit 1; fi
printf 'Criar usuário admin (senha com no mínimo 16 caracteres).\n'
IFS= read -r -s -p 'Nova senha: ' password; printf '\n'
IFS= read -r -s -p 'Confirmar senha: ' confirm; printf '\n'
if [ "${#password}" -lt 16 ] || [ "$password" != "$confirm" ]; then unset password confirm; echo 'Senha curta ou confirmação diferente. Nenhuma alteração.' >&2; exit 1; fi
unset confirm
# A password is transmitted only through stdin, never via command arguments or environment.
printf '%s' "$password" | docker exec -i websystem-websystem-1 node --input-type=module -e '
import {DatabaseSync} from "node:sqlite";
import {randomBytes,scryptSync} from "node:crypto";
let pw="";for await(const chunk of process.stdin)pw+=chunk.toString();
if(pw.length<16)throw Error("Senha curta");
const db=new DatabaseSync("/app/data/auth.sqlite");
try{
 db.exec("BEGIN IMMEDIATE");
 if(db.prepare("SELECT count(*) n FROM users").get().n!==0)throw Error("Usuário já existente; abortado");
 const salt=randomBytes(24).toString("hex");
 const digest=scryptSync(pw,salt,64).toString("hex");
 db.prepare("INSERT INTO users(username,password_salt,password_hash,role) VALUES (?,?,?,?)").run("admin",salt,digest,"admin");
 db.exec("COMMIT");
 console.log("ADMIN_CREATED: usuário admin criado com senha criptografada");
}catch(e){if(db.isTransaction)db.exec("ROLLBACK");console.error("ERRO:",e.message);process.exitCode=1}finally{db.close()}
'
unset password
