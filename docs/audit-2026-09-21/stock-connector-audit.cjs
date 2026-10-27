const path=require('node:path');const fs=require('node:fs');
const req=require('node:module').createRequire(path.resolve(__dirname,'../../apps/api/package.json'));
const {PrismaClient}=req('@prisma/client');
const db=new PrismaClient({datasources:{db:{url:'postgresql://stello:stello@localhost:15455/stello?schema=public'}}});
const API='http://localhost:13001/api/v1';const results=[];
function check(name,ok,evidence){const r={name,result:ok?'PASS':'FAIL',evidence};results.push(r);console.log(JSON.stringify(r));}
async function call(route,body,token){const r=await fetch(API+route,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
(async()=>{
 const a=(await call('/auth/login',{email:'admin@demo.com',password:'password123'})).data;
 if(!a.accessToken)throw Error('Fixture login failed');const A=a.accessToken;
 const o=await db.outlet.findFirst({where:{tenantId:a.user.tenantId,name:{contains:'Koramangala'}}});
 const material=await db.rawMaterial.create({data:{tenantId:a.user.tenantId,outletId:o.id,name:'Audit concurrent stock '+Date.now(),unit:'KG',stockQty:10,costPerUnit:10}});
 let requests;
 await db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM raw_materials WHERE id = ${material.id} FOR UPDATE`;
  requests=[call(`/outlets/${o.id}/inventory/materials/${material.id}/receive`,{quantity:5,unitCost:10},A),call(`/outlets/${o.id}/inventory/materials/${material.id}/receive`,{quantity:5,unitCost:10},A)];
  await new Promise(r=>setTimeout(r,800));
 });
 const r=await Promise.all(requests);const after=await db.rawMaterial.findUnique({where:{id:material.id}});
 check('concurrent stock receipts preserve both quantities',Number(after.stockQty)===20,{before:10,receipts:[5,5],expected:20,actual:Number(after.stockQty),statuses:r.map(x=>x.status)});
 const item=await db.item.findFirst({where:{outletId:o.id,name:'Paneer Tikka'},include:{addonGroups:{include:{group:{include:{addons:true}}}}}});
 const group=item.addonGroups[0]?.group;
 if(group){
  const excess=Array.from({length:group.maxSelect+1},()=>group.addons[0].id);
  const order=await call('/orders',{outletId:o.id,orderType:'TAKEAWAY',items:[{itemId:item.id,quantity:1,addonIds:excess}]},A);
  check('modifier maximum and duplicate add-ons rejected',order.status>=400,{maxSelect:group.maxSelect,submitted:excess.length,status:order.status});
 }
 const smokeDb=new PrismaClient({datasources:{db:{url:'postgresql://stello:stello@localhost:15455/stello_smoke?schema=public'}}});
 try{
  const smokeOutlet=await smokeDb.outlet.findFirst({where:{name:{contains:'Koramangala'}}});
  const r=await fetch('http://localhost:13003/push/zomato/menu',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({outletId:smokeOutlet.id})});
  const data=await r.json();check('connector outbound menu endpoint requires authentication',r.status===401||r.status===403,{status:r.status,snapshotRows:data.snapshot?.length});
 }finally{await smokeDb.$disconnect();}
})().catch(e=>{results.push({name:'supplementary audit exception',result:'ERROR',evidence:String(e)});console.error(e);process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(__dirname,'stock-connector-results.json'),JSON.stringify({at:new Date().toISOString(),results},null,2));await db.$disconnect();});
