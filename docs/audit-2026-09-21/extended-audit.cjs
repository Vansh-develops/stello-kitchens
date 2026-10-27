const path=require('node:path');
const {createRequire}=require('node:module');
const {writeFileSync,mkdtempSync}=require('node:fs');
const {tmpdir}=require('node:os');
const req=createRequire(path.resolve(__dirname,'../../apps/api/package.json'));
const {PrismaClient}=req('@prisma/client');
const db=new PrismaClient({datasources:{db:{url:'postgresql://stello:stello@localhost:15455/stello?schema=public'}}});
const API='http://localhost:13001/api/v1';
const rows=[];
function check(name,ok,evidence){const row={name,result:ok?'PASS':'FAIL',evidence};rows.push(row);console.log(JSON.stringify(row));}
async function call(method,route,body,token){const r=await fetch(API+route,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};}
async function run(){
 const a=(await call('POST','/auth/login',{email:'admin@demo.com',password:'password123'})).data;
 const c=(await call('POST','/auth/login',{email:'cashier@demo.com',password:'password123'})).data;
 if(!a.accessToken||!c.accessToken)throw Error('Fixture login failed');
 const A=a.accessToken,C=c.accessToken;
 const outlets=(await call('GET','/outlets',undefined,A)).data;
 const o=outlets.find(x=>x.name.includes('Koramangala')), other=outlets.find(x=>x.id!==o.id);
 const prefix='/outlets/'+o.id;
 const snapshot=(await call('GET','/sync/snapshot?outletId='+o.id,undefined,A)).data;
 const item=snapshot.menu.flatMap(x=>x.items).find(x=>!x.name.startsWith('Audit ')&&x.inStock&&!x.variations.length&&!x.addonGroups.length);
 const lines=[{itemId:item.id,quantity:1}];
 const tenant=await db.tenant.findUnique({where:{id:a.user.tenantId}});
 try{
   await db.tenant.update({where:{id:tenant.id},data:{status:'SUSPENDED'}});
   const access=await call('GET','/outlets',undefined,A);
   check('suspended tenant access blocked',access.status>=400,{status:access.status});
 }finally{await db.tenant.update({where:{id:tenant.id},data:{status:tenant.status}});}
 const dashboardRequire=createRequire(path.resolve(__dirname,'../../apps/dashboard/package.json'));
 const {io}=dashboardRequire('socket.io-client');
 const socket=io('http://localhost:13001',{auth:{token:C},transports:['websocket'],reconnection:false});
 try{
   await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('socket connect timeout')),5000);socket.on('connect',()=>{clearTimeout(t);resolve();});socket.on('connect_error',reject);});
   const ack=await new Promise(resolve=>{socket.timeout(2000).emit('join',{outletId:other.id},(err,data)=>resolve(err?{error:String(err)}:data));});
   check('socket refuses unassigned outlet in same tenant',ack?.joined===null,{ack});
 }finally{socket.disconnect();}
 const normal=(await call('POST','/orders',{outletId:o.id,orderType:'TAKEAWAY',items:lines},A)).data;
 const payments={payments:[{mode:'CASH',amount:normal.total}],customerPhone:'9000000099',customerName:'Isolated Audit'};
 await call('POST','/orders/'+normal.id+'/settle',payments,A);
 const customer=await db.customer.findUnique({where:{outletId_phone:{outletId:o.id,phone:'9000000099'}}});
 check('settlement records CRM customer and loyalty',!!customer&&customer.totalOrders>0&&customer.loyaltyPoints>0,{orders:customer?.totalOrders,points:customer?.loyaltyPoints});
 const day=new Date().toISOString().slice(0,10);
 const report=await call('GET',prefix+'/reports/overview?from='+day+'&to='+day,undefined,A);
 check('owner sales overview responds',report.status===200&&report.data.orders>0,{status:report.status,orders:report.data.orders});
 const denied=await call('GET',prefix+'/reports/overview?from='+day+'&to='+day,undefined,C);
 check('cashier reports permission denied',denied.status===403,{status:denied.status});
 const dbUser=await db.user.findUnique({where:{id:c.user.id}});
 const raw='audit-reset-'+Date.now();
 const {createHash}=require('node:crypto');
 await db.authToken.create({data:{type:'PASSWORD_RESET',userId:dbUser.id,email:dbUser.email,tokenHash:createHash('sha256').update(raw).digest('hex'),expiresAt:new Date(Date.now()+60000)}});
 try{
  const reset=await call('POST','/auth/reset-password',{token:raw,newPassword:'Audit-Temporary-2026!'});
  const prior=await call('GET','/auth/me',undefined,C);
  check('password reset invalidates existing session',reset.status===201&&prior.status===401,{resetStatus:reset.status,oldTokenStatus:prior.status});
 }finally{await db.user.update({where:{id:dbUser.id},data:{passwordHash:dbUser.passwordHash}});}
 // Deliberate timestamp tie fixture demonstrates pagination, not a load benchmark.
 const mark=new Date('2030-01-01T00:00:00Z');
 await db.order.createMany({data:Array.from({length:205},(_,i)=>({tenantId:a.user.tenantId,outletId:o.id,orderType:'TAKEAWAY',status:'CANCELLED',customerName:'Cursor audit '+i,updatedAt:mark}))});
 const p1=await call('GET','/sync/pull?outletId='+o.id+'&since=2029-12-31T00:00:00.000Z',undefined,A);
 const p2=await call('GET','/sync/pull?outletId='+o.id+'&since='+encodeURIComponent(p1.data.cursor),undefined,A);
 check('sync cursor preserves records sharing a timestamp',p1.data.orders.length+p2.data.orders.length===205,{firstPage:p1.data.orders.length,secondPage:p2.data.orders.length,fixtureRows:205});
 // Optional native engine is tested directly using a disposable SQLite directory.
 try{
  const {EdgeEngine}=require('../../apps/edge/sidecar/engine.js');
  const engine=new EdgeEngine({dataDir:mkdtempSync(path.join(tmpdir(),'stello-commercial-audit-')),apiUrl:API});
  await engine.bootstrap({email:'admin@demo.com',password:'password123',outletId:o.id});
  engine.forcedOffline=true;
  const offline=engine.createOrder({orderType:'TAKEAWAY',items:lines});
  const settled=engine.settleOrder(offline.clientId,{payments:[{mode:'CASH',amount:offline.total}]});
  check('offline local billing and persistence',settled.status==='SETTLED'&&engine.pendingCount()===1,{total:settled.total,pending:engine.pendingCount()});
  // Catalog changes after offline sale: historical sale must retain original total.
  const dbItem=await db.item.findUnique({where:{id:item.id}});
  try{
   await db.item.update({where:{id:item.id},data:{price:Number(dbItem.price)+10}});
   engine.forcedOffline=false;
   const pushed=await engine.sync();
   const server=await db.order.findFirst({where:{deviceId:engine.deviceId,clientId:offline.clientId},include:{payments:true}});
   check('offline sale retains price after catalog change',server&&Number(server.total)===settled.total,{offlineTotal:settled.total,serverTotal:server?Number(server.total):null,paid:server?.payments.reduce((s,p)=>s+Number(p.amount),0),pushed});
  }finally{await db.item.update({where:{id:item.id},data:{price:dbItem.price}});engine.db.close();}
 }catch(e){rows.push({name:'offline engine tests',result:'BLOCKED',evidence:String(e)});console.log('EDGE BLOCKED: '+String(e));}
}
run().catch(e=>{console.error(e);rows.push({name:'extended audit exception',result:'ERROR',evidence:String(e)});process.exitCode=1;}).finally(async()=>{writeFileSync(path.join(__dirname,'extended-results.json'),JSON.stringify({at:new Date().toISOString(),results:rows},null,2));await db.$disconnect();});
