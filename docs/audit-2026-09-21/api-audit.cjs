// Destructive test-fixture operations are restricted to the disposable local audit DB.
const { createRequire } = require('node:module');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const apiRequire = createRequire(path.resolve(__dirname, '../../apps/api/package.json'));
const { PrismaClient } = apiRequire('@prisma/client');
const db = new PrismaClient({datasources:{db:{url:'postgresql://stello:stello@localhost:15455/stello?schema=public'}}});
const API = 'http://localhost:13001/api/v1';
const results = [];
const stamp = Date.now().toString();
async function request(method, route, body, token) {
  const start = performance.now();
  const r = await fetch(API + route, {method, headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})}, ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const t = await r.text(); let data; try { data=JSON.parse(t); } catch { data=t; }
  return {status:r.status,data,ms:Math.round(performance.now()-start)};
}
function record(name, passed, evidence) { const row={name,result:passed?'PASS':'FAIL',evidence};results.push(row);console.log(JSON.stringify(row)); }
async function run() {
  const admin=(await request('POST','/auth/login',{email:'admin@demo.com',password:'password123'})).data;
  const cashier=(await request('POST','/auth/login',{email:'cashier@demo.com',password:'password123'})).data;
  const kitchen=(await request('POST','/auth/login',{email:'kitchen@demo.com',password:'password123'})).data;
  if(!admin.accessToken || !cashier.accessToken || !kitchen.accessToken)throw Error('Fixture login failed');
  const A=admin.accessToken,C=cashier.accessToken,K=kitchen.accessToken;
  const outlets=(await request('GET','/outlets',undefined,A)).data;
  const outlet=outlets.find(o=>o.name.includes('Koramangala'));
  const other=outlets.find(o=>o.id!==outlet.id);
  const base=`/outlets/${outlet.id}`;
  const menu=(await request('GET',base+'/menu',undefined,A)).data;
  const categories=Array.isArray(menu)?menu:menu.categories;
  const item=categories.flatMap(c=>c.items).find(i=>!i.name.startsWith('Audit ') && i.inStock && !i.variations.length && !i.addonGroups.length);
  const lines=[{itemId:item.id,quantity:1}];
  const create=async(extra={},token=A)=>(await request('POST','/orders',{outletId:outlet.id,orderType:'TAKEAWAY',items:lines,...extra},token));
  record('unauthenticated order access denied',(await request('GET','/orders?outletId='+outlet.id)).status===401,{});
  const denied=await request('GET',`/outlets/${other.id}/menu`,undefined,C);
  record('cashier cannot read unassigned outlet',denied.status===403,{status:denied.status});
  const kDenied=await create({},K);
  record('kitchen cannot create order',kDenied.status===403,{status:kDenied.status});
  const malformed=await create({items:[{itemId:item.id,quantity:-1}]});
  record('negative order quantity rejected',malformed.status===400,{status:malformed.status});

  const materialsBefore=await db.rawMaterial.findMany({where:{outletId:outlet.id}});
  const order=await create();
  record('create order and KOT',order.status===201 && order.data.kots?.length>0,{status:order.status,total:order.data.total,kots:order.data.kots?.length});
  const tickets=(await request('GET',base+'/kds/tickets',undefined,K)).data;
  const ticket=tickets.find(t=>t.orderId===order.data.id);
  const bump=ticket?await request('POST',`/kds/kots/${ticket.kotId}/advance`,{stationId:ticket.stationId,toStatus:'READY'},K):null;
  record('order visible in kitchen and can become ready',!!ticket && bump?.status===201,{visible:!!ticket,bumpStatus:bump?.status});
  const underpay=await request('POST',`/orders/${order.data.id}/settle`,{payments:[{mode:'CASH',amount:1}]},C);
  record('online underpayment rejected',underpay.status===400,{status:underpay.status});
  const settle=await request('POST',`/orders/${order.data.id}/settle`,{payments:[{mode:'CASH',amount:order.data.total}]},C);
  record('cash settlement and authoritative bill',settle.status===201 && settle.data.status==='SETTLED' && !!settle.data.billNumber,{status:settle.status,bill:settle.data.billNumber,total:settle.data.total});
  const repeat=await request('POST',`/orders/${order.data.id}/settle`,{payments:[{mode:'CASH',amount:order.data.total}]},C);
  record('sequential duplicate settlement rejected',repeat.status===400,{status:repeat.status});
  const rf1=await request('POST',base+`/payments/${order.data.id}/refund`,{amount:order.data.total,mode:'CASH',reason:'Isolated audit'},A);
  const rf2=await request('POST',base+`/payments/${order.data.id}/refund`,{amount:order.data.total,mode:'CASH',reason:'Isolated repeat audit'},A);
  const refundSum=await db.refund.aggregate({where:{orderId:order.data.id},_sum:{amount:true}});
  record('cumulative refunds cannot exceed sale',Number(refundSum._sum.amount)<=order.data.total,{statuses:[rf1.status,rf2.status],sale:order.data.total,refunded:Number(refundSum._sum.amount)});

  const race=await create();
  let settlementRequests;
  await db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${race.data.id} FOR UPDATE`;
    settlementRequests=Array.from({length:3},()=>request('POST',`/orders/${race.data.id}/settle`,{payments:[{mode:'CASH',amount:race.data.total}]},A));
    await new Promise(resolve=>setTimeout(resolve,800));
  });
  const raceResults=await Promise.all(settlementRequests);
  const savedRace=await db.order.findUnique({where:{id:race.data.id},include:{payments:true}});
  record('concurrent settlements create one payment',savedRace.payments.length===1,{statuses:raceResults.map(r=>r.status),paymentRows:savedRace.payments.length,total:Number(savedRace.total),paid:savedRace.payments.reduce((s,p)=>s+Number(p.amount),0)});

  const ft=await db.tenant.create({data:{name:'Audit foreign '+stamp}});
  const fb=await db.brand.create({data:{tenantId:ft.id,name:'Audit foreign'}});
  const fo=await db.outlet.create({data:{tenantId:ft.id,brandId:fb.id,name:'Audit foreign'}});
  const fa=await db.area.create({data:{tenantId:ft.id,outletId:fo.id,name:'Private foreign area'}});
  const table=await db.diningTable.create({data:{tenantId:ft.id,outletId:fo.id,areaId:fa.id,name:'Private foreign table '+stamp}});
  const cross=await create({orderType:'DINE_IN',tableId:table.id},C);
  record('cross-tenant table reference rejected',cross.status>=400,{status:cross.status,returnedTableName:cross.data.tableName,storedForeignReference:cross.data.id?!!(await db.order.findFirst({where:{id:cross.data.id,tableId:table.id}})):false});

  const foreignRead=await request('GET',`/outlets/${fo.id}/menu`,undefined,A);
  record('direct foreign tenant menu read rejected',foreignRead.status>=400,{status:foreignRead.status});

  const ownArea=await db.area.findFirst({where:{outletId:outlet.id}});
  const ownTable=await db.diningTable.create({data:{tenantId:admin.user.tenantId,outletId:outlet.id,areaId:ownArea.id,name:'Audit race '+stamp}});
  const tableRace=await Promise.all([create({orderType:'DINE_IN',tableId:ownTable.id}),create({orderType:'DINE_IN',tableId:ownTable.id})]);
  const tableOrders=await db.order.count({where:{tableId:ownTable.id,status:'OPEN'}});
  record('one open order per dining table under concurrency',tableOrders===1,{statuses:tableRace.map(r=>r.status),openOrders:tableOrders});

  const pub=(await request('GET',base+'/scan-requests/public-token',undefined,A)).data.token;
  const submit=await request('POST',`/public/scan/kiosk/${pub}/order`,{items:lines});
  const pending=await db.orderRequest.findUnique({where:{token:submit.data.requestToken}});
  const countBefore=await db.order.count({where:{outletId:outlet.id}});
  const accepted=await Promise.all([request('POST',base+`/scan-requests/${pending.id}/accept`,{},A),request('POST',base+`/scan-requests/${pending.id}/accept`,{},A)]);
  const countAfter=await db.order.count({where:{outletId:outlet.id}});
  record('QR acceptance is idempotent under concurrency',countAfter-countBefore===1,{statuses:accepted.map(r=>r.status),ordersCreated:countAfter-countBefore});

  const syncBody={outletId:outlet.id,deviceId:'unregistered-audit-'+stamp,orders:[{clientId:'unpaid-'+stamp,orderType:'TAKEAWAY',items:lines,payments:[],status:'SETTLED',clientUpdatedAt:new Date().toISOString()}]};
  const sync=await request('POST','/sync/push',syncBody,C);
  const synced=sync.data.results?.[0]?.serverId?await db.order.findUnique({where:{id:sync.data.results[0].serverId},include:{payments:true}}):null;
  record('offline settled orders require correct payment',sync.status>=400 || sync.data.results?.[0]?.status==='error',{httpStatus:sync.status,result:sync.data.results?.[0]?.status,saleTotal:synced?Number(synced.total):null,paymentRows:synced?.payments.length,deviceRegistered:!!(await db.terminal.findUnique({where:{id:syncBody.deviceId}}))});
  const replay=await request('POST','/sync/push',syncBody,C);
  record('offline push retry deduplicated',replay.data.results?.[0]?.status==='duplicate',{result:replay.data.results?.[0]?.status});

  const tiny=await db.item.create({data:{tenantId:admin.user.tenantId,outletId:outlet.id,categoryId:categories[0].id,name:'Audit one rupee '+stamp,price:1,taxRate:5}});
  const tinyOrder=await create({items:[{itemId:tiny.id,quantity:1}]});
  await request('POST',`/orders/${tinyOrder.data.id}/settle`,{payments:[{mode:'CASH',amount:tinyOrder.data.total}]},A);
  const inv=await request('GET',base+`/invoices/${tinyOrder.data.id}`,undefined,A);
  const tax=Number((inv.data.cgst+inv.data.sgst+inv.data.igst).toFixed(2));
  record('invoice split tax reconciles to order tax',tax===tinyOrder.data.taxAmount,{orderTax:tinyOrder.data.taxAmount,invoiceTax:tax,cgst:inv.data.cgst,sgst:inv.data.sgst,total:inv.data.total});

  const unauthReady=await request('GET','/health/ready');
  record('database readiness succeeds',unauthReady.status===200,{status:unauthReady.status});
}
run().catch(e=>{console.error(e);results.push({name:'audit script exception',result:'ERROR',evidence:String(e)});process.exitCode=1;}).finally(async()=>{writeFileSync(path.join(__dirname,'api-results.json'),JSON.stringify({at:new Date().toISOString(),environment:'isolated localhost:13001 / postgres localhost:15455',results},null,2));await db.$disconnect();});
