import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
if(process.env.NODE_ENV==='production'&&!process.env.DB_PATH)throw new Error('Configura DB_PATH en un volumen persistente.');
const path = process.env.DB_PATH || join(here, 'data', 'split.sqlite');
mkdirSync(dirname(path), { recursive: true });
export const db = new DatabaseSync(path);
db.exec(`PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '✈️', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, description TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), paid_by INTEGER NOT NULL REFERENCES members(id), category TEXT NOT NULL DEFAULT 'Otros', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS expense_shares (expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE, member_id INTEGER NOT NULL REFERENCES members(id), share_cents INTEGER NOT NULL CHECK(share_cents >= 0), PRIMARY KEY(expense_id, member_id));
CREATE TABLE IF NOT EXISTS settlements (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, from_member INTEGER NOT NULL REFERENCES members(id), to_member INTEGER NOT NULL REFERENCES members(id), amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);
if(!db.prepare('PRAGMA table_info(members)').all().some(column=>column.name==='active')){
  db.exec('ALTER TABLE members ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))');
}
if(!db.prepare('PRAGMA table_info(members)').all().some(column=>column.name==='person_key')){
  db.exec('ALTER TABLE members ADD COLUMN person_key TEXT');
}
export function transaction(work){
  db.exec('BEGIN IMMEDIATE');
  try{
    const result=work();
    db.exec('COMMIT');
    return result;
  }catch(error){
    db.exec('ROLLBACK');
    throw error;
  }
}
transaction(()=>{
if(process.env.NODE_ENV!=='production'&&db.prepare('PRAGMA user_version').get().user_version===0
  &&db.prepare('SELECT COUNT(*) as n FROM groups').get().n===0){
  const g = db.prepare('INSERT INTO groups (name, emoji) VALUES (?, ?)').run('Viaje a la playa', '🏖️').lastInsertRowid;
  const ins = db.prepare('INSERT INTO members (group_id, name) VALUES (?, ?)');
  const ana = Number(ins.run(g,'Ana').lastInsertRowid), luis = Number(ins.run(g,'Luis').lastInsertRowid), sofia = Number(ins.run(g,'Sofía').lastInsertRowid);
  const exp = db.prepare('INSERT INTO expenses (group_id,description,amount_cents,paid_by,category) VALUES (?,?,?,?,?)');
  const share=db.prepare('INSERT INTO expense_shares (expense_id, member_id,share_cents) VALUES (?,?,?)');
  for (const [description,amount,payer,category] of [['Cena frente al mar',90000,ana,'Comida'],['Gasolina',60000,luis,'Transporte'],['Snacks y bebidas',30000,sofia,'Comida']]) {
    const id=Number(exp.run(g,description,amount,payer,category).lastInsertRowid);
    for(const memberId of [ana,luis,sofia])share.run(id,memberId,amount/3);
  }
}
db.exec(`UPDATE members SET person_key=lower(hex(randomblob(16))) WHERE person_key IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS members_group_person ON members(group_id,person_key);
PRAGMA user_version=1;`);
});
