import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
let plugin;
vm.runInNewContext(source, { window:{ __ModuleLoader__:{ load: entry => { assert.equal(entry.id,'@dsh-rlm/onboarding'); plugin=entry.factory(name=> name==='react' ? {createElement(){}} : {Modal(){}}); } } } });
const ok = value => ({ok:true,value});
function fixture({provider='codex', accounts=[{}], ref, writable=true, commit=true}={}) {
  let snapshot={status:'ready', writable, revision:7, value:{provider:'old',model:'old',reasoningEffort:'high'}};
  const writes=[];
  const catalog={groups:[{id:provider,models:[{id:'model-1',name:'Model'}]}],failures:[]};
  const scope={ getSnapshot:()=>snapshot, async mutate(ops, revision){writes.push({ops,revision}); if(commit) snapshot={...snapshot,value:{provider:ops[0].value,model:ops[1].value},revision:8};} };
  const ctx={
    remote:{
      llm:{listProviders:async()=>ok([{id:provider,name:provider}]),listConfigurableProviders:async()=>ok([{provider,displayName:provider,settingsNs:'adapter',settingsPath:[]}])},
      session:{modelCatalog:async()=>ok(catalog)},
      credentials:{describe:async()=>ok(ref?{[ref]:{configured:true}}:{})}
    },
    connection:{rpc:{call:async(channel,endpoint)=>{assert.equal(channel,'/api');assert.equal(endpoint,'subscriptions-auth.status');return ok({providers:{[provider]:{accounts}}});}}},
    settingsScope:{describe:()=>({ensure:async()=>{},getSnapshot:()=>({view:{namespaces:[{ns:'adapter',value:ref?{apiKeyEnv:ref}:{}}]}})}),bind:({namespace})=>{assert.equal(namespace,'agent-default-model');return scope;}}
  };
  return {ctx,writes,catalog,scope};
}
test('supported cell shadowing preserves models and welcome registrations',()=>{
  const registrations=[];
  plugin.apply({slots:{inject:(_,f)=>f(),register:(options,component)=>registrations.push({options,component})}});
  assert.equal(registrations.length,2);
  const step=registrations[0].options;
  assert.equal(step.name,'settings.onboarding');assert.equal(step.id,'deepseek-official');assert.equal(step.priority,-100);
  assert.equal(registrations[1].options.id,'dsh-rlm-setup');
  assert.ok(!registrations.some(r=>r.options.id==='models'||r.options.id==='welcome-notice'));
});
test('catalog presence is not subscription authentication',async()=>{
  const {ctx}=fixture({accounts:[]});const facts=await plugin.loadFacts(ctx);
  assert.equal(facts.rows[0].auth,'missing');assert.equal(plugin.selectable(facts,'codex','model-1',true),false);
});
test('unavailable auth status fails closed',async()=>{
  const {ctx}=fixture();ctx.connection.rpc.call=async()=>{throw Error('secret transport diagnostics');};
  const facts=await plugin.loadFacts(ctx);assert.equal(plugin.selectable(facts,'codex','model-1',true),false);
});
test('API credentials read host reference without handling a secret',async()=>{
  const {ctx}=fixture({provider:'anthropic',ref:'MY_KEY'});const facts=await plugin.loadFacts(ctx);
  assert.equal(facts.rows[0].auth,'stored');assert.equal(facts.rows[0].authSection,'models');
  assert.equal(plugin.selectable(facts,'anthropic','model-1',false),true);
});
test('external auth requires explicit acknowledgement; unknown models rejected',async()=>{
  const {ctx}=fixture({provider:'local'});const facts=await plugin.loadFacts(ctx);
  assert.equal(plugin.selectable(facts,'local','model-1',false),false);
  assert.equal(plugin.selectable(facts,'local','model-1',true),true);
  assert.equal(plugin.selectable(facts,'local','invented',true),false);
});
test('inactive declarations cannot be selected',async()=>{
  const {ctx}=fixture();ctx.remote.llm.listProviders=async()=>ok([]);
  const facts=await plugin.loadFacts(ctx);assert.equal(facts.rows[0].active,false);assert.equal(plugin.selectable(facts,'codex','model-1',true),false);
});
test('save fences atomic default change, clears stale effort, and reads back',async()=>{
  const {ctx,writes}=fixture();await plugin.saveDefault(ctx,null,'codex','model-1',false);
  assert.equal(writes.length,1);assert.equal(writes[0].revision,7);
  assert.equal(writes[0].ops[2].op,'unset');assert.equal(writes[0].ops[2].path[0],'reasoningEffort');
});
test('failed write/readback never claims successful setup',async()=>{
  const {ctx}=fixture({commit:false});await assert.rejects(plugin.saveDefault(ctx,null,'codex','model-1',false),/not confirmed/);
});
test('read-only default and revoked auth prevent write',async()=>{
  for(const options of [{writable:false},{accounts:[]}]){
    const {ctx,writes}=fixture(options);await assert.rejects(plugin.saveDefault(ctx,null,'codex','model-1',false));assert.equal(writes.length,0);
  }
});

test('business transport errors do not become successful facts',async()=>{
  const {ctx}=fixture();ctx.remote.llm.listProviders=async()=>({ok:false,error:{message:'private'}});
  const facts=await plugin.loadFacts(ctx);
  assert.equal(facts.rows.length,1);
  assert.equal(plugin.selectable(facts,'codex','model-1',true),false);
  assert.match(facts.warnings.join(' '),/Active providers/);
  assert.ok(!JSON.stringify(facts).includes('private'));
});
