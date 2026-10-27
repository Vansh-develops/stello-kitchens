// Small correctness/latency smoke, NOT a production capacity benchmark.
const fs=require('node:fs'),path=require('node:path');const API='http://localhost:13001/api/v1';
const timings=[],errors=[],bills=[];let token,next=0;
async function call(method,route,body){const start=performance.now();const r=await fetch(API+route,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(route!='/auth/login')timings.push(performance.now()-start);if(!r.ok)throw Error(route+': '+r.status+' '+JSON.stringify(data));return data;}
(async()=>{token=(await call('POST','/auth/login',{email:'admin@demo.com',password:'password123'})).accessToken;
 const outlets=await call('GET','/outlets');const o=outlets.find(x=>x.name.includes('Koramangala'));
 const menu=await call('GET',`/outlets/${o.id}/menu`);const item=menu.flatMap(x=>x.items).find(x=>x.name==='Chicken 65');timings.length=0;
 const start=performance.now();await Promise.all(Array.from({length:5},async()=>{while(next<50){const i=next++;try{const order=await call('POST','/orders',{outletId:o.id,orderType:'TAKEAWAY',items:[{itemId:item.id,quantity:1}],customerName:'Local latency audit '+i});const settled=await call('POST',`/orders/${order.id}/settle`,{payments:[{mode:'CASH',amount:order.total}]});bills.push(settled.billNumber);}catch(e){errors.push(String(e));}}}));
 timings.sort((a,b)=>a-b);const percentile=p=>Math.round(timings[Math.ceil(timings.length*p)-1]);
 const result={at:new Date().toISOString(),environment:'local Windows / Node 23.1.0 / disposable Docker PostgreSQL',scope:'50 order-create + settlement workflows, five concurrent workers',requests:timings.length,completed:bills.length,uniqueBills:new Set(bills).size,errors,elapsedMs:Math.round(performance.now()-start),latencyMs:{p50:percentile(.5),p95:percentile(.95),p99:percentile(.99)}};
 fs.writeFileSync(path.join(__dirname,'local-load-results.json'),JSON.stringify(result,null,2));console.log(result);
})().catch(e=>{console.error(e);process.exitCode=1;});
