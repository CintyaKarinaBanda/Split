import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, transaction } from './db.js';
import { configureAccess } from './access.js';
import { route } from './route.js';
import { calculateBalances, suggestPayments, allocateEqualShares } from './logic.js';

const production=process.env.NODE_ENV==='production';
const app=express();
app.disable('x-powered-by');
if(production&&process.env.RENDER==='true')app.set('trust proxy',1);
if(!production)app.use(cors());
app.use(express.json({limit:'50kb'}));
if(production)app.use((_req,res,next)=>{
 res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'});
 next();
});
await configureAccess(app,{enabled:production,ownerKey:process.env.SPLIT_OWNER_KEY});
const fail=(res,status,message)=>res.status(status).json({error:message});
const validText=x=>typeof x==='string'&&x.trim().length>0&&x.trim().length<=100;
const groupExists=async id=>Boolean((await db.prepare('SELECT 1 FROM groups WHERE id=?').get(id)));
const getMembers=async id=>(await db.prepare('SELECT * FROM members WHERE group_id=? ORDER BY id').all(id));
const guest=req=>production&&!req.access?.owner;
const findGroups=async ()=>(await db.prepare('SELECT id,name,emoji,created_at FROM groups ORDER BY id DESC').all());
class RequestError extends Error{
 constructor(status,message){
  super(message);
  this.status=status;
 }
}
function change(status,handler){
 return route(async (req,res)=>{
  const result=await transaction(async ()=>{
   if(guest(req)&&req.params.id&&!await db.prepare('SELECT 1 FROM access_grants WHERE token_hash=? AND group_id=?')
    .get(req.access.id,Number(req.params.id)))throw new RequestError(404,'Plan no disponible.');
   return handler(req);
  });
  res.status(status).json(result);
 });
}
async function replaceExpenseShares(expenseId,amountCents,memberIds){
 await db.batch([
  {sql:'DELETE FROM expense_shares WHERE expense_id=?',args:[expenseId]},
  ...allocateEqualShares(amountCents,memberIds).map(share=>({
   sql:'INSERT INTO expense_shares (expense_id,member_id,share_cents) VALUES (?,?,?)',
   args:[expenseId,share.member_id,share.share_cents],
  })),
 ]);
}
async function planRecalculation(groupId,expenseIds,removedId=null){
 if(!Array.isArray(expenseIds)||new Set(expenseIds).size!==expenseIds.length
  ||!expenseIds.every(id=>Number.isSafeInteger(id)&&id>0))return null;
 const expenseById=db.prepare('SELECT id,amount_cents FROM expenses WHERE group_id=? AND id=?');
 const expenseMembers=db.prepare(`SELECT m.id,m.active FROM expense_shares s
  JOIN members m ON m.id=s.member_id WHERE s.expense_id=? ORDER BY m.id`);
 const adjustments=[];
 for(const expenseId of expenseIds){
  const expense=(await expenseById.get(groupId,expenseId));
  if(!expense)return null;
  const participants=(await expenseMembers.all(expenseId));
  const remaining=participants.filter(member=>member.active&&member.id!==removedId);
  if(remaining.length===0||remaining.length===participants.length)return null;
  adjustments.push({expense,memberIds:remaining.map(member=>member.id)});
 }
 return adjustments;
}
async function applyRecalculation(adjustments){
 for(const {expense,memberIds} of adjustments)await replaceExpenseShares(expense.id,expense.amount_cents,memberIds);
}
async function getGroup(id){
  const [{rows:[group]},{rows:members},{rows:shares},{rows:expenseRows},{rows:settlements}]=await db.batch([
   'SELECT * FROM groups WHERE id=?',
   'SELECT * FROM members WHERE group_id=? ORDER BY id',
   `SELECT s.expense_id,s.member_id,s.share_cents
    FROM expense_shares s JOIN expenses e ON e.id=s.expense_id WHERE e.group_id=? ORDER BY s.member_id`,
   'SELECT * FROM expenses WHERE group_id=? ORDER BY id DESC',
   'SELECT * FROM settlements WHERE group_id=? ORDER BY id DESC',
  ].map(sql=>({sql,args:[id]})),'read');
  if(!group)return null;
  const sharesByExpense=new Map();
  for(const {expense_id,member_id,share_cents} of shares){
   if(!sharesByExpense.has(expense_id))sharesByExpense.set(expense_id,[]);
   sharesByExpense.get(expense_id).push({member_id,share_cents});
  }
  const expenses=expenseRows.map(e=>({...e,shares:sharesByExpense.get(e.id)??[]}));
  const balances=calculateBalances(members,expenses,settlements);
  return {...group,members,expenses,settlements,balances,suggested_payments:suggestPayments(balances)};
}
app.get('/api/health',route(async (_req,res)=>res.json({ok:true,service:'SPLIT API'})));
app.get('/api/groups',route(async (req,res)=>res.json(guest(req)
 ?(await db.prepare(`SELECT g.id,g.name,g.emoji,g.created_at FROM groups g JOIN access_grants a ON a.group_id=g.id
   WHERE a.token_hash=? ORDER BY g.id DESC`).all(req.access.id))
 :await findGroups())));
app.post('/api/groups',change(201,async req=>{
  if(guest(req))throw new RequestError(403,'Solo la persona administradora puede crear planes.');
  if(!validText(req.body.name))throw new RequestError(400,'Nombre de grupo inválido');
  const result=(await db.prepare('INSERT INTO groups (name,emoji) VALUES (?,?)').run(req.body.name.trim(),typeof req.body.emoji==='string'?req.body.emoji.slice(0,8):'✨'));
  return await getGroup(Number(result.lastInsertRowid));
}));
app.get('/api/groups/:id',route(async (req,res)=>{const group=await getGroup(Number(req.params.id));return group?res.json(group):fail(res,404,'Grupo no encontrado');}));
app.delete('/api/groups/:id',change(200,async req=>{
 if(guest(req))throw new RequestError(403,'Solo la persona administradora puede eliminar planes.');
 const id=Number(req.params.id);
 if(!await groupExists(id))throw new RequestError(404,'Grupo no encontrado');
 const statements=[
  'DELETE FROM expense_shares WHERE expense_id IN (SELECT id FROM expenses WHERE group_id=?)',
  'DELETE FROM settlements WHERE group_id=?',
  'DELETE FROM expenses WHERE group_id=?',
  'DELETE FROM members WHERE group_id=?',
 ];
 if(production)statements.push('DELETE FROM access_grants WHERE group_id=?','DELETE FROM plan_invites WHERE group_id=?');
 statements.push('DELETE FROM groups WHERE id=?');
 await db.batch(statements.map(sql=>({sql,args:[id]})));
 return {groups:await findGroups()};
}));
app.get('/api/groups/:id/people',route(async (req,res)=>{
 const id=Number(req.params.id);
 if(!await groupExists(id))return fail(res,404,'Grupo no encontrado');
 const scope=guest(req)?'AND person.group_id IN (SELECT group_id FROM access_grants WHERE token_hash=?)':'';
 res.json((await db.prepare(`SELECT person.person_key,person.name,GROUP_CONCAT(DISTINCT groups.name) AS plans
  FROM members AS person JOIN groups ON groups.id=person.group_id
  WHERE NOT EXISTS (SELECT 1 FROM members WHERE group_id=? AND active=1 AND person_key=person.person_key)
  ${scope} GROUP BY person.person_key,person.name ORDER BY person.name COLLATE NOCASE,person.person_key`)
  .all(id,...(guest(req)?[req.access.id]:[]))));
}));
app.post('/api/groups/:id/members',change(201,async req=>{
 const id=Number(req.params.id);
 const {name,person_key,expense_ids=[]}=req.body;
 if(!await groupExists(id))throw new RequestError(404,'Grupo no encontrado');
 if(!Array.isArray(expense_ids)||new Set(expense_ids).size!==expense_ids.length
  ||!expense_ids.every(expenseId=>Number.isSafeInteger(expenseId)&&expenseId>0)){
  throw new RequestError(400,'Selección de gastos inválida');
 }
 const personScope=guest(req)?'AND group_id IN (SELECT group_id FROM access_grants WHERE token_hash=?)':'';
 const person=typeof person_key==='string'
  ?(await db.prepare(`SELECT person_key,name FROM members WHERE person_key=? ${personScope} LIMIT 1`)
   .get(person_key,...(guest(req)?[req.access.id]:[])))
  :null;
 if(person_key!==undefined&&!person)throw new RequestError(404,'Persona no encontrada');
 if(!person&&!validText(name))throw new RequestError(400,'Nombre de integrante inválido');
 const membership=person&&(await db.prepare('SELECT id,active FROM members WHERE group_id=? AND person_key=?').get(id,person_key));
 if(membership?.active)throw new RequestError(409,'Esta persona ya pertenece al plan');
 const expenseById=db.prepare('SELECT id,amount_cents FROM expenses WHERE id=? AND group_id=?');
 const expenses=await Promise.all(expense_ids.map(expenseId=>expenseById.get(expenseId,id)));
 if(expenses.some(expense=>!expense))throw new RequestError(400,'Los gastos seleccionados deben pertenecer al plan');

 const memberId=membership?.id??Number((await db.prepare('INSERT INTO members (group_id,name,person_key) VALUES (?,?,?)')
  .run(id,person?.name??name.trim(),person?.person_key??randomUUID())).lastInsertRowid);
 if(membership)await db.prepare('UPDATE members SET active=1 WHERE id=?').run(memberId);
 const participants=db.prepare('SELECT member_id FROM expense_shares WHERE expense_id=? ORDER BY member_id');
 for(const expense of expenses){
  const ids=(await participants.all(expense.id)).map(share=>share.member_id);
  if(!ids.includes(memberId))await replaceExpenseShares(expense.id,expense.amount_cents,[...ids,memberId]);
 }
 return {...await getGroup(id),added_member_id:memberId};
}));
app.patch('/api/groups/:id/members/:memberId',change(200,async req=>{
 const groupId=Number(req.params.id), memberId=Number(req.params.memberId);
 if(!validText(req.body.name))throw new RequestError(400,'Nombre de integrante inválido');
 const member=(await db.prepare('SELECT person_key FROM members WHERE id=? AND group_id=? AND active=1').get(memberId,groupId));
 if(!member)throw new RequestError(404,'Integrante activo no encontrado');
 if(guest(req)&&(await db.prepare('SELECT 1 FROM members WHERE person_key=? AND group_id<>? LIMIT 1').get(member.person_key,groupId))){
  throw new RequestError(403,'Solo la persona administradora puede actualizar este nombre.');
 }
 (await db.prepare('UPDATE members SET name=? WHERE person_key=?').run(req.body.name.trim(),member.person_key));
 return await getGroup(groupId);
}));
app.delete('/api/groups/:id/members/:memberId',change(200,async req=>{
 const groupId=Number(req.params.id), memberId=Number(req.params.memberId);
 const expenseIds=req.body?.expense_ids??[];
 if(!(await db.prepare('SELECT 1 FROM members WHERE id=? AND group_id=?').get(memberId,groupId))){
  throw new RequestError(404,'Integrante no encontrado');
 }
 const adjustments=await planRecalculation(groupId,expenseIds,memberId);
 if(!adjustments)throw new RequestError(400,'El reparto necesita al menos un participante activo por gasto');
 await db.prepare('UPDATE members SET active=0 WHERE id=? AND group_id=?').run(memberId,groupId);
 await applyRecalculation(adjustments);
 return await getGroup(groupId);
}));
app.post('/api/groups/:id/recalculate-shares',change(200,async req=>{
 const groupId=Number(req.params.id);
 if(!await groupExists(groupId))throw new RequestError(404,'Grupo no encontrado');
 const adjustments=await planRecalculation(groupId,req.body.expense_ids);
 if(!adjustments?.length)throw new RequestError(400,'Selecciona gastos que aún tengan participantes activos');
 await applyRecalculation(adjustments);
 return await getGroup(groupId);
}));
async function saveExpense(req){
 const id=Number(req.params.id);
 const editing=req.params.expenseId!==undefined;
 const previous=editing?(await db.prepare('SELECT * FROM expenses WHERE group_id=? AND id=?')
  .get(id,Number(req.params.expenseId))):null;
 if(editing&&!previous)throw new RequestError(404,'Gasto no encontrado');
 if(!editing&&!await groupExists(id))throw new RequestError(404,'Grupo no encontrado');

 const originalIds=previous?(await db.prepare('SELECT member_id FROM expense_shares WHERE expense_id=? ORDER BY member_id')
  .all(previous.id)).map(share=>share.member_id):[];
 const activeIds=(await getMembers(id)).filter(member=>member.active).map(member=>member.id);
 const {
  description=previous?.description,
  amount_cents=previous?.amount_cents,
  paid_by=previous?.paid_by,
  category=previous?.category,
  participant_ids,
 }=req.body;
 if(!validText(description))throw new RequestError(400,'Concepto inválido');
 if(!Number.isSafeInteger(amount_cents)||amount_cents<=0||amount_cents>100000000000)throw new RequestError(400,'Monto inválido');
 const ids=participant_ids??(previous?originalIds:activeIds);
 const allowedParticipants=new Set([...activeIds,...originalIds]);
 if(!Array.isArray(ids)||ids.length===0||new Set(ids).size!==ids.length||!ids.every(memberId=>allowedParticipants.has(memberId))){
  throw new RequestError(400,'Participantes inválidos');
 }
 if(!activeIds.includes(paid_by)&&(!previous||paid_by!==previous.paid_by))throw new RequestError(400,'Persona pagadora inválida');

 const expenseFields=[description.trim(),amount_cents,paid_by,validText(category)?category.trim():'Otros'];
 const sameSplit=previous&&previous.amount_cents===amount_cents&&ids.length===originalIds.length
  &&originalIds.every(memberId=>ids.includes(memberId));
 let expenseId;
 if(previous){
  expenseId=previous.id;
  await db.prepare('UPDATE expenses SET description=?,amount_cents=?,paid_by=?,category=? WHERE id=?').run(...expenseFields,expenseId);
 }else{
  const result=await db.prepare('INSERT INTO expenses (description,amount_cents,paid_by,category,group_id) VALUES (?,?,?,?,?)')
   .run(...expenseFields,id);
  expenseId=Number(result.lastInsertRowid);
 }
 if(!sameSplit)await replaceExpenseShares(expenseId,amount_cents,ids);
 return getGroup(id);
}
app.post('/api/groups/:id/expenses',change(201,saveExpense));
app.patch('/api/groups/:id/expenses/:expenseId',change(200,saveExpense));
app.delete('/api/groups/:id/expenses/:expenseId',change(200,async req=>{
 const id=Number(req.params.id),expenseId=Number(req.params.expenseId);
 await db.prepare('DELETE FROM expense_shares WHERE expense_id IN (SELECT id FROM expenses WHERE group_id=? AND id=?)').run(id,expenseId);
 const result=(await db.prepare('DELETE FROM expenses WHERE group_id=? AND id=?').run(id,expenseId));
 if(!result.changes)throw new RequestError(404,'Gasto no encontrado');
 return await getGroup(id);
}));
app.post('/api/groups/:id/settlements',change(201,async req=>{
 const id=Number(req.params.id),{from_member,to_member,amount_cents}=req.body;
 const group=await getGroup(id);if(!group)throw new RequestError(404,'Grupo no encontrado');
 if(!Number.isSafeInteger(amount_cents)||amount_cents<=0||from_member===to_member||!group.members.some(m=>m.id===from_member)||!group.members.some(m=>m.id===to_member))throw new RequestError(400,'Pago inválido');
 const suggested=group.suggested_payments.find(p=>p.from_member===from_member&&p.to_member===to_member&&p.amount_cents>=amount_cents);
 if(!suggested)throw new RequestError(400,'El pago no corresponde a una deuda pendiente sugerida');
 (await db.prepare('INSERT INTO settlements (group_id,from_member,to_member,amount_cents) VALUES (?,?,?,?)').run(id,from_member,to_member,amount_cents));
 return await getGroup(id);
}));
app.delete('/api/groups/:id/settlements/:settlementId',change(200,async req=>{
 const groupId=Number(req.params.id);
 const settlementId=Number(req.params.settlementId);
 const result=(await db.prepare('DELETE FROM settlements WHERE id=? AND group_id=?').run(settlementId,groupId));
 if(!result.changes)throw new RequestError(404,'Pago registrado no encontrado');
 return await getGroup(groupId);
}));
app.use('/api',route(async (_req,res)=>fail(res,404,'Ruta no encontrada')));
if(production){
 const dist=fileURLToPath(new URL('../client/dist/',import.meta.url));
 if(!existsSync(fileURLToPath(new URL('../client/dist/index.html',import.meta.url))))throw new Error('Compila el cliente con npm run build.');
 app.use('/assets',express.static(fileURLToPath(new URL('../client/dist/assets/',import.meta.url)),{immutable:true,maxAge:'1y',fallthrough:false}));
 app.use(express.static(dist,{maxAge:0,setHeaders:res=>res.set('Cache-Control','no-cache')}));
}
app.use((err,_req,res,_next)=>{
 if(err instanceof RequestError)return fail(res,err.status,err.message);
 if(err.status===400)return fail(res,400,'La solicitud debe contener JSON válido');
 if(err.status===413)return fail(res,413,'La solicitud es demasiado grande');
 if(err.status===404)return fail(res,404,'Archivo no encontrado');
 console.error(err);
 return fail(res,500,'Error inesperado');
});
const port=Number(process.env.PORT ?? 3001);
app.listen(port,production?(process.env.HOST||'0.0.0.0'):'127.0.0.1',function(){
 console.log(`SPLIT API disponible en http://127.0.0.1:${this.address().port}`);
});
