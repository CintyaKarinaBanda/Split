import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, transaction } from './db.js';
import { configureAccess } from './access.js';
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
configureAccess(app,{enabled:production,ownerKey:process.env.SPLIT_OWNER_KEY});
const fail=(res,status,message)=>res.status(status).json({error:message});
const validText=x=>typeof x==='string'&&x.trim().length>0&&x.trim().length<=100;
const groupExists=id=>Boolean(db.prepare('SELECT 1 FROM groups WHERE id=?').get(id));
const getMembers=id=>db.prepare('SELECT * FROM members WHERE group_id=? ORDER BY id').all(id);
const guest=req=>production&&!req.access?.owner;
const findGroups=()=>db.prepare('SELECT id,name,emoji,created_at FROM groups ORDER BY id DESC').all();
function replaceExpenseShares(expenseId,amountCents,memberIds){
 db.prepare('DELETE FROM expense_shares WHERE expense_id=?').run(expenseId);
 const insert=db.prepare('INSERT INTO expense_shares (expense_id,member_id,share_cents) VALUES (?,?,?)');
 for(const share of allocateEqualShares(amountCents,memberIds))insert.run(expenseId,share.member_id,share.share_cents);
}
function planRecalculation(groupId,expenseIds,removedId=null){
 if(!Array.isArray(expenseIds)||new Set(expenseIds).size!==expenseIds.length
  ||!expenseIds.every(id=>Number.isSafeInteger(id)&&id>0))return null;
 const expenseById=db.prepare('SELECT id,amount_cents FROM expenses WHERE group_id=? AND id=?');
 const expenseMembers=db.prepare(`SELECT m.id,m.active FROM expense_shares s
  JOIN members m ON m.id=s.member_id WHERE s.expense_id=? ORDER BY m.id`);
 const adjustments=[];
 for(const expenseId of expenseIds){
  const expense=expenseById.get(groupId,expenseId);
  if(!expense)return null;
  const participants=expenseMembers.all(expenseId);
  const remaining=participants.filter(member=>member.active&&member.id!==removedId);
  if(remaining.length===0||remaining.length===participants.length)return null;
  adjustments.push({expense,memberIds:remaining.map(member=>member.id)});
 }
 return adjustments;
}
function applyRecalculation(adjustments){
 for(const {expense,memberIds} of adjustments)replaceExpenseShares(expense.id,expense.amount_cents,memberIds);
}
function getGroup(id){
  const group=db.prepare('SELECT * FROM groups WHERE id=?').get(id);
  if(!group)return null;
  const members=getMembers(id);
  const expenses=db.prepare('SELECT * FROM expenses WHERE group_id=? ORDER BY id DESC').all(id).map(e=>({...e,shares:db.prepare('SELECT member_id,share_cents FROM expense_shares WHERE expense_id=?').all(e.id)}));
  const settlements=db.prepare('SELECT * FROM settlements WHERE group_id=? ORDER BY id DESC').all(id);
  const balances=calculateBalances(members,expenses,settlements);
  return {...group,members,expenses,settlements,balances,suggested_payments:suggestPayments(balances)};
}
app.get('/api/health',(_req,res)=>res.json({ok:true,service:'SPLIT API'}));
app.get('/api/groups',(req,res)=>res.json(guest(req)
 ?db.prepare(`SELECT g.id,g.name,g.emoji,g.created_at FROM groups g JOIN access_grants a ON a.group_id=g.id
   WHERE a.token_hash=? ORDER BY g.id DESC`).all(req.access.id)
 :findGroups()));
app.post('/api/groups',(req,res)=>{
  if(guest(req))return fail(res,403,'Solo la persona administradora puede crear planes.');
  if(!validText(req.body.name))return fail(res,400,'Nombre de grupo inválido');
  const result=db.prepare('INSERT INTO groups (name,emoji) VALUES (?,?)').run(req.body.name.trim(),typeof req.body.emoji==='string'?req.body.emoji.slice(0,8):'✨');
  res.status(201).json(getGroup(Number(result.lastInsertRowid)));
});
app.get('/api/groups/:id',(req,res)=>{const group=getGroup(Number(req.params.id));return group?res.json(group):fail(res,404,'Grupo no encontrado');});
app.delete('/api/groups/:id',(req,res)=>{
 if(guest(req))return fail(res,403,'Solo la persona administradora puede eliminar planes.');
 const result=db.prepare('DELETE FROM groups WHERE id=?').run(Number(req.params.id));
 return result.changes?res.json({groups:findGroups()}):fail(res,404,'Grupo no encontrado');
});
app.get('/api/groups/:id/people',(req,res)=>{
 const id=Number(req.params.id);
 if(!groupExists(id))return fail(res,404,'Grupo no encontrado');
 const scope=guest(req)?'AND person.group_id IN (SELECT group_id FROM access_grants WHERE token_hash=?)':'';
 res.json(db.prepare(`SELECT person.person_key,person.name,GROUP_CONCAT(DISTINCT groups.name) AS plans
  FROM members AS person JOIN groups ON groups.id=person.group_id
  WHERE NOT EXISTS (SELECT 1 FROM members WHERE group_id=? AND active=1 AND person_key=person.person_key)
  ${scope} GROUP BY person.person_key,person.name ORDER BY person.name COLLATE NOCASE,person.person_key`)
  .all(id,...(guest(req)?[req.access.id]:[])));
});
app.post('/api/groups/:id/members',(req,res)=>{
 const id=Number(req.params.id);
 const {name,person_key,expense_ids=[]}=req.body;
 if(!groupExists(id))return fail(res,404,'Grupo no encontrado');
 if(!Array.isArray(expense_ids)||new Set(expense_ids).size!==expense_ids.length
  ||!expense_ids.every(expenseId=>Number.isSafeInteger(expenseId)&&expenseId>0)){
  return fail(res,400,'Selección de gastos inválida');
 }
 const personScope=guest(req)?'AND group_id IN (SELECT group_id FROM access_grants WHERE token_hash=?)':'';
 const person=typeof person_key==='string'
  ?db.prepare(`SELECT person_key,name FROM members WHERE person_key=? ${personScope} LIMIT 1`)
   .get(person_key,...(guest(req)?[req.access.id]:[]))
  :null;
 if(person_key!==undefined&&!person)return fail(res,404,'Persona no encontrada');
 if(!person&&!validText(name))return fail(res,400,'Nombre de integrante inválido');
 const membership=person&&db.prepare('SELECT id,active FROM members WHERE group_id=? AND person_key=?').get(id,person_key);
 if(membership?.active)return fail(res,409,'Esta persona ya pertenece al plan');
 const expenseById=db.prepare('SELECT id,amount_cents FROM expenses WHERE id=? AND group_id=?');
 const expenses=expense_ids.map(expenseId=>expenseById.get(expenseId,id));
 if(expenses.some(expense=>!expense))return fail(res,400,'Los gastos seleccionados deben pertenecer al plan');

 const memberId=transaction(()=>{
  const memberId=membership?.id??Number(db.prepare('INSERT INTO members (group_id,name,person_key) VALUES (?,?,?)')
   .run(id,person?.name??name.trim(),person?.person_key??randomUUID()).lastInsertRowid);
  if(membership)db.prepare('UPDATE members SET active=1 WHERE id=?').run(memberId);
  if(expenses.length){
   const participants=db.prepare('SELECT member_id FROM expense_shares WHERE expense_id=? ORDER BY member_id');
   const saveShare=db.prepare(`INSERT INTO expense_shares (expense_id,member_id,share_cents) VALUES (?,?,?)
    ON CONFLICT(expense_id,member_id) DO UPDATE SET share_cents=excluded.share_cents`);
   for(const expense of expenses){
    const ids=participants.all(expense.id).map(share=>share.member_id);
    if(ids.includes(memberId))continue;
    for(const share of allocateEqualShares(expense.amount_cents,[...ids,memberId])){
     saveShare.run(expense.id,share.member_id,share.share_cents);
    }
   }
  }
  return memberId;
 });
 res.status(201).json({...getGroup(id),added_member_id:memberId});
});
app.patch('/api/groups/:id/members/:memberId',(req,res)=>{
 const groupId=Number(req.params.id), memberId=Number(req.params.memberId);
 if(!validText(req.body.name))return fail(res,400,'Nombre de integrante inválido');
 const member=db.prepare('SELECT person_key FROM members WHERE id=? AND group_id=? AND active=1').get(memberId,groupId);
 if(!member)return fail(res,404,'Integrante activo no encontrado');
 if(guest(req)&&db.prepare('SELECT 1 FROM members WHERE person_key=? AND group_id<>? LIMIT 1').get(member.person_key,groupId)){
  return fail(res,403,'Solo la persona administradora puede actualizar este nombre.');
 }
 db.prepare('UPDATE members SET name=? WHERE person_key=?').run(req.body.name.trim(),member.person_key);
 return res.json(getGroup(groupId));
});
app.delete('/api/groups/:id/members/:memberId',(req,res)=>{
 const groupId=Number(req.params.id), memberId=Number(req.params.memberId);
 const expenseIds=req.body?.expense_ids??[];
 if(!db.prepare('SELECT 1 FROM members WHERE id=? AND group_id=?').get(memberId,groupId)){
  return fail(res,404,'Integrante no encontrado');
 }
 const adjustments=planRecalculation(groupId,expenseIds,memberId);
 if(!adjustments)return fail(res,400,'El reparto necesita al menos un participante activo por gasto');
 transaction(()=>{
  db.prepare('UPDATE members SET active=0 WHERE id=? AND group_id=?').run(memberId,groupId);
  applyRecalculation(adjustments);
 });
 res.json(getGroup(groupId));
});
app.post('/api/groups/:id/recalculate-shares',(req,res)=>{
 const groupId=Number(req.params.id);
 if(!groupExists(groupId))return fail(res,404,'Grupo no encontrado');
 const adjustments=planRecalculation(groupId,req.body.expense_ids);
 if(!adjustments?.length)return fail(res,400,'Selecciona gastos que aún tengan participantes activos');
 transaction(()=>applyRecalculation(adjustments));
 res.json(getGroup(groupId));
});
function saveExpense(req,res){
 const id=Number(req.params.id);
 const editing=req.params.expenseId!==undefined;
 const previous=editing?db.prepare('SELECT * FROM expenses WHERE group_id=? AND id=?')
  .get(id,Number(req.params.expenseId)):null;
 if(editing&&!previous)return fail(res,404,'Gasto no encontrado');
 if(!editing&&!groupExists(id))return fail(res,404,'Grupo no encontrado');

 const originalIds=previous?db.prepare('SELECT member_id FROM expense_shares WHERE expense_id=? ORDER BY member_id')
  .all(previous.id).map(share=>share.member_id):[];
 const activeIds=getMembers(id).filter(member=>member.active).map(member=>member.id);
 const {
  description=previous?.description,
  amount_cents=previous?.amount_cents,
  paid_by=previous?.paid_by,
  category=previous?.category,
  participant_ids,
 }=req.body;
 if(!validText(description))return fail(res,400,'Concepto inválido');
 if(!Number.isSafeInteger(amount_cents)||amount_cents<=0||amount_cents>100000000000)return fail(res,400,'Monto inválido');
 const ids=participant_ids??(previous?originalIds:activeIds);
 const allowedParticipants=new Set([...activeIds,...originalIds]);
 if(!Array.isArray(ids)||ids.length===0||new Set(ids).size!==ids.length||!ids.every(memberId=>allowedParticipants.has(memberId))){
  return fail(res,400,'Participantes inválidos');
 }
 if(!activeIds.includes(paid_by)&&(!previous||paid_by!==previous.paid_by))return fail(res,400,'Persona pagadora inválida');

 const expenseFields=[description.trim(),amount_cents,paid_by,validText(category)?category.trim():'Otros'];
 const sameSplit=previous&&previous.amount_cents===amount_cents&&ids.length===originalIds.length
  &&originalIds.every(memberId=>ids.includes(memberId));
 transaction(()=>{
  let expenseId;
  if(previous){
   expenseId=previous.id;
   db.prepare('UPDATE expenses SET description=?,amount_cents=?,paid_by=?,category=? WHERE id=?').run(...expenseFields,expenseId);
  }else{
   const result=db.prepare('INSERT INTO expenses (description,amount_cents,paid_by,category,group_id) VALUES (?,?,?,?,?)')
    .run(...expenseFields,id);
   expenseId=result.lastInsertRowid;
  }
  if(!sameSplit)replaceExpenseShares(expenseId,amount_cents,ids);
 });
 res.status(previous?200:201).json(getGroup(id));
}
app.post('/api/groups/:id/expenses',saveExpense);
app.patch('/api/groups/:id/expenses/:expenseId',saveExpense);
app.delete('/api/groups/:id/expenses/:expenseId',(req,res)=>{
 const id=Number(req.params.id),expenseId=Number(req.params.expenseId);
 const result=db.prepare('DELETE FROM expenses WHERE group_id=? AND id=?').run(id,expenseId);
 return result.changes?res.json(getGroup(id)):fail(res,404,'Gasto no encontrado');
});
app.post('/api/groups/:id/settlements',(req,res)=>{
 const id=Number(req.params.id),{from_member,to_member,amount_cents}=req.body;
 const group=getGroup(id);if(!group)return fail(res,404,'Grupo no encontrado');
 if(!Number.isSafeInteger(amount_cents)||amount_cents<=0||from_member===to_member||!group.members.some(m=>m.id===from_member)||!group.members.some(m=>m.id===to_member))return fail(res,400,'Pago inválido');
 const suggested=group.suggested_payments.find(p=>p.from_member===from_member&&p.to_member===to_member&&p.amount_cents>=amount_cents);
 if(!suggested)return fail(res,400,'El pago no corresponde a una deuda pendiente sugerida');
 db.prepare('INSERT INTO settlements (group_id,from_member,to_member,amount_cents) VALUES (?,?,?,?)').run(id,from_member,to_member,amount_cents);
 res.status(201).json(getGroup(id));
});
app.delete('/api/groups/:id/settlements/:settlementId',(req,res)=>{
 const groupId=Number(req.params.id);
 const settlementId=Number(req.params.settlementId);
 const result=db.prepare('DELETE FROM settlements WHERE id=? AND group_id=?').run(settlementId,groupId);
 return result.changes?res.json(getGroup(groupId)):fail(res,404,'Pago registrado no encontrado');
});
app.use('/api',(_req,res)=>fail(res,404,'Ruta no encontrada'));
if(production){
 const dist=fileURLToPath(new URL('../client/dist/',import.meta.url));
 if(!existsSync(fileURLToPath(new URL('../client/dist/index.html',import.meta.url))))throw new Error('Compila el cliente con npm run build.');
 app.use('/assets',express.static(fileURLToPath(new URL('../client/dist/assets/',import.meta.url)),{immutable:true,maxAge:'1y',fallthrough:false}));
 app.use(express.static(dist,{maxAge:0,setHeaders:res=>res.set('Cache-Control','no-cache')}));
}
app.use((err,_req,res,_next)=>{
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
