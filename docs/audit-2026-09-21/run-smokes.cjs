const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const results=[];
let index=10;
for(const app of ['api','edge','connector']){
 for(const file of fs.readdirSync(path.join(root,'apps',app)).filter(x=>x.endsWith('-smoke.mjs'))){
  const script=path.join(root,'apps',app,file);
  const run=spawnSync(process.execPath,['--import',require('node:url').pathToFileURL(path.join(__dirname,'smoke-local-preload.mjs')).href,script],{
   cwd:path.dirname(script),encoding:'utf8',timeout:120000,
   env:{...process.env,DATABASE_URL:'postgresql://stello:stello@localhost:15455/stello_smoke?schema=public',CONNECTOR_KEY:'dev-connector-key',AUDIT_SMOKE_INDEX:String(index++)}
  });
  const output=(run.stdout||'')+'\n'+(run.stderr||'');
  fs.writeFileSync(path.join(__dirname,app+'-'+file+'.log'),output);
  const counts=output.match(/(\d+) passed, (\d+) failed/);
  const row={app,file,exit:run.status,assertions:counts?{passed:Number(counts[1]),failed:Number(counts[2])}:null,error:run.error?String(run.error):null};
  results.push(row);console.log(JSON.stringify(row));
 }
}
fs.writeFileSync(path.join(__dirname,'smoke-results.json'),JSON.stringify({at:new Date().toISOString(),results},null,2));
