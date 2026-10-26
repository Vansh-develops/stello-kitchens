// Route the repository's hardcoded smoke-test URLs ONLY to the isolated audit servers.
// No product logic is modified. Give each script a distinct synthetic IP to avoid
// unrelated scripts exhausting the shared per-IP login budget.
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init={})=>{
 const url=new URL(typeof input==='string'?input:input.url);
 if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Audit smoke external network blocked');
 if(url.port==='3001')url.port='13011';
 else if(url.port==='3003')url.port='13003';
 else throw Error('Audit smoke unexpected port '+url.port);
 const headers=new Headers(init.headers);
 headers.set('x-forwarded-for','127.0.1.'+(process.env.AUDIT_SMOKE_INDEX||'1'));
 return originalFetch(url,{...init,headers});
};
