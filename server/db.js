import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const remoteUrl = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (Boolean(remoteUrl) !== Boolean(authToken)) throw new Error('Configura TURSO_DATABASE_URL y TURSO_AUTH_TOKEN juntos.');
if (process.env.NODE_ENV === 'production' && !remoteUrl && !process.env.DB_PATH) {
  throw new Error('Configura Turso o DB_PATH en un volumen persistente.');
}
const path = process.env.DB_PATH || join(here, 'data', 'split.sqlite');
const context = new AsyncLocalStorage();
let local;
let remote;
if (remoteUrl) {
  const { createClient } = await import('@libsql/client/http');
  remote = createClient({ url: remoteUrl, authToken, intMode: 'number' });
} else {
  if(path!==':memory:')mkdirSync(dirname(path), { recursive: true });
  local = new DatabaseSync(path);
  local.exec('PRAGMA foreign_keys = ON');
}

let pending = Promise.resolve();
function localOperation(work) {
  const result = pending.then(work);
  pending = result.catch(() => {});
  return result;
}
async function execute(sql, args, method) {
  const connection = context.getStore();
  if (remote) {
    const result = await (connection ?? remote).execute({ sql, args });
    if (method === 'run') return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
    return method === 'get' ? result.rows[0] : result.rows;
  }
  const work = () => local.prepare(sql)[method](...args);
  return connection ? work() : localOperation(work);
}
export const db = {
  prepare: sql => ({
    get: (...args) => execute(sql, args, 'get'),
    all: (...args) => execute(sql, args, 'all'),
    run: (...args) => execute(sql, args, 'run'),
  }),
  exec(sql) {
    const connection = context.getStore();
    if (remote) return (connection ?? remote).executeMultiple(sql);
    return connection ? local.exec(sql) : localOperation(() => local.exec(sql));
  },
  batch(statements,mode='write') {
    const connection=context.getStore();
    if(remote) return connection?connection.batch(statements):remote.batch(statements,mode);
    const work=()=>statements.map(({sql,args=[]})=>{
      const statement=local.prepare(sql);
      if(mode==='read')return {rows:statement.all(...args)};
      statement.run(...args);
    });
    return connection?work():localOperation(work);
  },
};

export async function transaction(work, mode = 'write') {
  if (context.getStore()) return work();
  if (remote) {
    const tx = await remote.transaction(mode);
    try {
      const result = await context.run(tx, work);
      await tx.commit();
      return result;
    } finally {
      tx.close();
    }
  }
  return localOperation(async () => {
    local.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = await context.run(local, work);
      local.exec('COMMIT');
      return result;
    } catch (error) {
      local.exec('ROLLBACK');
      throw error;
    }
  });
}

await transaction(async () => {
await db.exec(`
CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '✈️', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, description TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), paid_by INTEGER NOT NULL REFERENCES members(id), category TEXT NOT NULL DEFAULT 'Otros', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS expense_shares (expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE, member_id INTEGER NOT NULL REFERENCES members(id), share_cents INTEGER NOT NULL CHECK(share_cents >= 0), PRIMARY KEY(expense_id, member_id));
CREATE TABLE IF NOT EXISTS settlements (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, from_member INTEGER NOT NULL REFERENCES members(id), to_member INTEGER NOT NULL REFERENCES members(id), amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);
const memberColumns=await db.prepare('PRAGMA table_info(members)').all();
if(!memberColumns.some(column=>column.name==='active')){
  await db.exec('ALTER TABLE members ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))');
}
if(!memberColumns.some(column=>column.name==='person_key')){
  await db.exec('ALTER TABLE members ADD COLUMN person_key TEXT');
}
if(!remote&&process.env.NODE_ENV!=='production'&&(await db.prepare('PRAGMA user_version').get()).user_version===0
  &&(await db.prepare('SELECT COUNT(*) as n FROM groups').get()).n===0){
  const g = Number((await db.prepare('INSERT INTO groups (name, emoji) VALUES (?, ?)').run('Viaje a la playa', '🏖️')).lastInsertRowid);
  const ins = db.prepare('INSERT INTO members (group_id, name) VALUES (?, ?)');
  const ana = Number((await ins.run(g,'Ana')).lastInsertRowid), luis = Number((await ins.run(g,'Luis')).lastInsertRowid), sofia = Number((await ins.run(g,'Sofía')).lastInsertRowid);
  const exp = db.prepare('INSERT INTO expenses (group_id,description,amount_cents,paid_by,category) VALUES (?,?,?,?,?)');
  const share=db.prepare('INSERT INTO expense_shares (expense_id, member_id,share_cents) VALUES (?,?,?)');
  for (const [description,amount,payer,category] of [['Cena frente al mar',90000,ana,'Comida'],['Gasolina',60000,luis,'Transporte'],['Snacks y bebidas',30000,sofia,'Comida']]) {
    const id=Number((await exp.run(g,description,amount,payer,category)).lastInsertRowid);
    for(const memberId of [ana,luis,sofia])await share.run(id,memberId,amount/3);
  }
}
await db.exec(`UPDATE members SET person_key=lower(hex(randomblob(16))) WHERE person_key IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS members_group_person ON members(group_id,person_key);`);
if(!remote)await db.exec('PRAGMA user_version=1');
});
