// Offline contract regression against the shipped SettingsScope implementation.
// DSH_NODE_MODULES=/absolute/installed/node_modules node --test project/onboarding/test/installed-settings-contract.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import vm from 'node:vm';

const modules = process.env.DSH_NODE_MODULES;
const ok = value => ({ok:true,value});
async function bundle(path, dependencies) {
  let result;
  vm.runInNewContext(await readFile(path, 'utf8'), {
    window:{__ModuleLoader__:{load(entry){result=entry.factory(name => {
      assert.ok(name in dependencies, `unexpected dependency ${name}`);
      return dependencies[name];
    });}}}
  });
  return result;
}

// Only the browser's generic service registration/store primitives are replaced.
// SettingsScopeBinder, SettingsDescribeMirror, ensure, snapshots, and all state
// transitions below execute the installed bundle unchanged (not copied mocks).
class Service {
  constructor(ctx, name) { this.ctx=ctx; ctx[name]=this; }
}
function createSnapshotStore(initial) {
  let value=initial;
  const listeners=new Set();
  return {getSnapshot:()=>value, set(next){value=next; for(const fn of listeners)fn();},
    subscribe(fn){listeners.add(fn); return ()=>listeners.delete(fn);}};
}
async function fixture({isLoopback=true, response=ok({namespaces:[]})}={}) {
  let reads=0;
  const settings = await bundle(join(modules,'@deepseek-ai/dsh-client-ui-settings/lib/client.js'), {
    '@deepseek-ai/cordis':{Service}, '@deepseek-ai/dsh-client-store':{createSnapshotStore}
  });
  const plugin = await bundle(process.env.DSH_ONBOARDING_CLIENT || new URL('../src/client.bundle.js',import.meta.url), {
    react:{createElement(){}}, '@deepseek-ai/dsh-client-ui-primitives':{Modal(){}}
  });
  const ctx={
    effect(run){run();}, on(){return ()=>{};},
    remote:{$host:{isLoopback}, $on(){return ()=>{};},
      settings:{async describe(){reads++; return response;}},
      llm:{async listProviders(){return ok([{id:'codex',name:'Codex'}]);},
        async listConfigurableProviders(){return ok([]);}},
      session:{async modelCatalog(){return ok({groups:[{id:'codex',models:[{id:'model'}]}],failures:[]});}}},
    connection:{rpc:{async call(){return ok({providers:{codex:{accounts:[]}}});}}}
  };
  settings.apply(ctx);
  return {ctx,plugin,reads:()=>reads};
}

test('installed settings ensure returns void; ready document is read from its snapshot', {skip:!modules}, async()=>{
  const {ctx,plugin,reads}=await fixture();
  const describe=ctx.settingsScope.describe();
  assert.equal(await describe.ensure(),undefined);
  assert.equal(describe.getSnapshot().status,'ready');
  assert.equal(reads(),1);
  const facts=await plugin.loadFacts(ctx);
  assert.equal(facts.rows[0].provider,'codex');
  assert.equal(facts.rows[0].auth,'missing');
});

for (const [name,options,status] of [
  ['non-loopback memory scope',{isLoopback:false},'unavailable'],
  ['failed initial Host read',{response:{ok:false,error:{message:'synthetic offline read failure'}}},'idle']
]) test(`provider list survives actual installed settings ${name}`,{skip:!modules},async()=>{
  const {ctx,plugin}=await fixture(options);
  const describe=ctx.settingsScope.describe();
  // A fulfilled ensure is NOT a guarantee of a settings view in rc3.
  assert.equal(await describe.ensure(),undefined);
  assert.equal(describe.getSnapshot().status,status);
  assert.equal(describe.getSnapshot().view,undefined);
  const facts=await plugin.loadFacts(ctx);
  assert.equal(facts.rows[0].provider,'codex');
  assert.equal(facts.rows[0].active,true);
  assert.notEqual(facts.rows[0].auth,'stored');
  assert.equal(plugin.selectable(facts,'codex','model',true),false);
});


test('catalog failure preserves provider directory without enabling a default', {skip:!modules},async()=>{
  const {ctx,plugin}=await fixture();
  ctx.remote.session.modelCatalog=async()=>({ok:false,error:{message:'synthetic catalog failure'}});
  const facts=await plugin.loadFacts(ctx);
  assert.equal(facts.rows[0].provider,'codex');
  assert.equal(facts.catalog.groups.length,0);
  assert.ok(facts.warnings.some(w=>w.includes('Model catalog')));
  assert.equal(plugin.selectable(facts,'codex','model',true),false);
});

test('credential failure preserves API directory but never confirms authentication', {skip:!modules},async()=>{
  const {ctx,plugin}=await fixture({response:ok({namespaces:[{ns:'adapter',value:{apiKeyEnv:'TEST_REFERENCE'}}]})});
  ctx.remote.llm.listProviders=async()=>ok([{id:'api',name:'API'}]);
  ctx.remote.llm.listConfigurableProviders=async()=>ok([{provider:'api',displayName:'API',settingsNs:'adapter',settingsPath:[]}]);
  ctx.remote.credentials={async describe(refs){
    assert.deepEqual(Array.from(refs),['TEST_REFERENCE']);
    return {ok:false,error:{message:'synthetic credential failure'}};
  }};
  const facts=await plugin.loadFacts(ctx);
  assert.equal(facts.rows[0].provider,'api');
  assert.equal(facts.rows[0].auth,'unknown');
  assert.ok(facts.warnings.some(w=>w.includes('Credential status')));
  assert.equal(plugin.selectable(facts,'api','model',true),false);
});
