// Optional offline integration with an installed subscription package (no HTTP listener).
// DSH_SUBSCRIPTIONS_DIR=/path/to/dsh-plugin-subscriptions node --test project/onboarding/test/installed-subscriptions.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,cp,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
const installed = process.env.DSH_SUBSCRIPTIONS_DIR;
test('onboarding consumes the real installed subscription status Fetch/RPC contract', {skip:!installed}, async t => {
  // Profile plugins may resolve peers through DSH's loader rather than Node. Copy
  // only to a throwaway directory and link explicit installed peers for this probe.
  let root=installed;
  if(process.env.DSH_NODE_MODULES) {
    const work=await mkdtemp(join(tmpdir(),'onboarding-rpc-'));
    t.after(()=>rm(work,{recursive:true,force:true}));
    root=join(work,'subscription'); await cp(installed,root,{recursive:true});
    await symlink(process.env.DSH_NODE_MODULES,join(work,'node_modules'));
  }
  const {registerAuthRpc} = await import(pathToFileURL(join(root,'lib/auth/rpc.js')));
  const routes = new Map();
  let accounts=[{id:'test-account'}];
  const context = {
    inject(names,apply) { assert.deepEqual(names,['connection']); apply(this); },
    get(name) { assert.equal(name,'connection'); return {fetch:{register(route){routes.set(route.path,route);return ()=>{};}}}; },
    effect(run) { run(); }
  };
  registerAuthRpc(context, {async status(provider) {
    if(provider==='grok') throw Error('simulated corrupt provider store');
    return {busy:false,accounts:provider==='codex'?accounts:[]};
  }}, {});
  let plugin;
  vm.runInNewContext(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'), {
    window:{__ModuleLoader__:{load(entry){plugin=entry.factory(name => name==='react'?{createElement(){}}:{Modal(){}});}}}
  });
  const ok=value=>({ok:true,value});
  const writes=[];
  let saved={status:'ready',writable:true,revision:4,value:{provider:'old',model:'old',reasoningEffort:'high',unrelated:'preserved'}};
  const ctx={
    connection:{rpc:{async call(channel,method,payload){
      const route=routes.get(`${channel}/${method}`);assert.ok(route,'installed endpoint must exist');
      const response=await route.fetch(new Request(`http://offline.invalid${route.path}`,{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({type:'client-request',rpcId:'offline-test',method,payload})
      }));
      assert.equal(response.status,200);const envelope=await response.json();
      assert.equal(envelope.rpcId,'offline-test');return envelope.result;
    }}},
    remote:{llm:{listProviders:async()=>ok([{id:'codex',name:'Codex'},{id:'grok',name:'Grok'}]),listConfigurableProviders:async()=>ok([])},
      session:{modelCatalog:async()=>ok({groups:[{id:'codex',models:[{id:'model'}]}],failures:[]})}},
    settingsScope:{describe:()=>({ensure:async()=>{},getSnapshot:()=>({view:{namespaces:[]}})}),
      bind:()=>({getSnapshot:()=>saved,async mutate(ops,revision){
        assert.equal(revision,4);writes.push(ops);
        for(const op of ops){if(op.op==='set')saved.value[op.path[0]]=op.value;else delete saved.value[op.path[0]];}
      }})}
  };
  const facts=await plugin.loadFacts(ctx);
  assert.equal(facts.rows.find(r=>r.provider==='codex').auth,'stored');
  assert.equal(facts.rows.find(r=>r.provider==='grok').auth,'missing');
  await plugin.saveDefault(ctx,facts,'codex','model',false);
  assert.equal(writes.length,1);assert.equal(saved.value.unrelated,'preserved');
  assert.equal(saved.value.reasoningEffort,undefined);
  accounts=[];
  await assert.rejects(plugin.saveDefault(ctx,facts,'codex','model',false),/not configured/);
  assert.equal(writes.length,1,'revocation must prevent a second write');
});
