// DSH_NODE_MODULES=/installed/node_modules node --test project/onboarding/test/client-activation.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const modules=process.env.DSH_NODE_MODULES;
test('installed Loader discovers onboarding client metadata and browser artifact', {skip:!modules}, async () => {
  const require=createRequire(pathToFileURL(join(modules,'../package.json')));
  const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
  const {Loader}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-loader')));
  const {ClientModuleRegistry}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-modules')));
  const turn=()=>new Promise(resolve=>setImmediate(resolve));
  const ctx=new Context();
  const loader=ctx.plugin(Loader,{baseUrl:new URL('../',import.meta.url).href});
  let registry;
  try {
    await turn();
    await ctx.loader.create({name:new URL('../lib/index.js',import.meta.url).href});
    await ctx.loader.await();
    registry=ctx.plugin(ClientModuleRegistry); await turn();
    assert.equal(ctx.clientModules.clientPath('@dsh-rlm/onboarding'),fileURLToPath(new URL('../lib/client.js',import.meta.url)));
    assert.match(JSON.stringify(ctx.clientModules.graph()),/@dsh-rlm\/onboarding/);
  } finally {await registry?.dispose();await loader.dispose();}
});

test('onboarding declares parent remote required by Cordis scoped slot contexts', {skip:!modules}, async () => {
  let loaded;
  vm.runInNewContext(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'),{
    window:{__ModuleLoader__:{load(entry){loaded=entry.factory(name=>name==='react'?{createElement(){}}:{Modal(){}});}}}
  });
  assert.ok(loaded.inject.includes('remote'));
});
