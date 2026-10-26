// Repair missing / shared smoke fixtures in the disposable smoke database only.
const path=require('node:path');const req=require('node:module').createRequire(path.resolve(__dirname,'../../apps/api/package.json'));
const {PrismaClient}=req('@prisma/client');const db=new PrismaClient({datasources:{db:{url:'postgresql://stello:stello@localhost:15455/stello_smoke?schema=public'}}});
(async()=>{
 const outlet=await db.outlet.findFirstOrThrow({where:{name:{contains:'Koramangala'}}});
 const base=await db.rawMaterial.findFirstOrThrow({where:{outletId:outlet.id,name:'Makhani Gravy Base'}});
 await db.rawMaterial.updateMany({where:{outletId:outlet.id},data:{stockQty:100}});
 await db.rawMaterial.update({where:{id:base.id},data:{stockQty:0,costPerUnit:0}});
 const channel=await db.channel.findFirstOrThrow({where:{outletId:outlet.id,name:'Zomato'}});
 const chicken=await db.rawMaterial.findFirstOrThrow({where:{outletId:outlet.id,name:'Chicken'}});
 const item=await db.item.findFirstOrThrow({where:{outletId:outlet.id,recipe:{some:{rawMaterialId:chicken.id}}}});
 if(!await db.aggregatorMenuMap.findFirst({where:{channelId:channel.id,externalId:'audit-chicken-mapped'}}))await db.aggregatorMenuMap.create({data:{channelId:channel.id,itemId:item.id,externalId:'audit-chicken-mapped'}});
 console.log('Restored zero opening balance for prep test; added missing chicken-recipe Zomato mapping. Test source unchanged.');
})().finally(()=>db.$disconnect());
