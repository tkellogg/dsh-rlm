import test from 'node:test';
import assert from 'node:assert/strict';
import {apply,inject,providerCatalog} from '../lib/index.js';

test('Host provider catalog resolves only the selected provider',async()=>{
  const listed=[];const resolved=[];
  const ctx={
    llm:{
      listProviders:()=>[{id:'selected',name:'Selected'},{id:'other',name:'Other'}],
      async listModels(provider){listed.push(provider);return [{id:'m1',name:'Model 1'}];},
      async resolveModelInfo(provider,model){resolved.push([provider,model]);return {reasoning:{efforts:[{id:'high',name:'High'}],defaultEffort:'high'}};}
    },
    agentDefaultModel:{currentSelection:()=>({provider:'selected',model:'m1'})}
  };
  const catalog=await providerCatalog(ctx,'selected');
  assert.deepEqual(listed,['selected']);
  assert.deepEqual(resolved,[['selected','m1']]);
  assert.equal(catalog.groups[0].id,'selected');
  assert.equal(catalog.groups[0].models[0].reasoning.defaultEffort,'high');
});

test('Host endpoint is registered during plugin readiness and preserves RPC envelope',async()=>{
  assert.deepEqual(inject,['connection','llm','agentDefaultModel']);
  let route;
  const ctx={
    connection:{fetch:{register(value){route=value;}}},
    llm:{listProviders:()=>[{id:'selected',name:'Selected'}],listModels:async()=>[{id:'m',name:'Model'}],resolveModelInfo:async()=>({})},
    agentDefaultModel:{currentSelection:()=>({provider:'selected',model:'m'})}
  };
  await apply(ctx);
  assert.equal(route.path,'/api/dsh-rlm/provider-catalog');
  const response=await route.fetch(new Request('http://offline.invalid/api/dsh-rlm/provider-catalog',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId:'test',method:'dsh-rlm/provider-catalog',payload:{provider:'selected'}})
  }));
  assert.equal(response.status,200);
  const envelope=await response.json();
  assert.equal(envelope.rpcId,'test');assert.equal(envelope.result.ok,true);
  assert.equal(envelope.result.value.groups[0].id,'selected');
});

test('Host route bounds input and never exposes adapter error text',async()=>{
  let route;
  const secret='provider-secret-must-not-leak';
  const ctx={
    connection:{fetch:{register(value){route=value;}}},
    llm:{listProviders:()=>[{id:'selected',name:'Selected'}],listModels:async()=>{throw new Error(secret);}},
    agentDefaultModel:{currentSelection:()=>({provider:'selected',model:'m'})}
  };
  await apply(ctx);
  const request=payload=>route.fetch(new Request('http://offline.invalid/api/dsh-rlm/provider-catalog',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId:'test',method:'dsh-rlm/provider-catalog',payload})
  }));
  const bad=await request({provider:'../bad'});const badBody=await bad.text();
  assert.equal(bad.status,200);assert.ok(!badBody.includes(secret));
  const failed=await request({provider:'selected'});const failedBody=await failed.text();
  assert.equal(failed.status,200);assert.ok(!failedBody.includes(secret));
  assert.match(failedBody,/Provider model catalog unavailable/);
  const tooLarge=await route.fetch(new Request('http://offline.invalid/api/dsh-rlm/provider-catalog',{
    method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(4097)
  }));
  assert.equal(tooLarge.status,413);
});

test('abort stops unscheduled model resolution work',async()=>{
  const controller=new AbortController();const resolved=[];
  const ctx={
    llm:{
      listProviders:()=>[{id:'selected',name:'Selected'}],
      listModels:async()=>[{id:'one',name:'One'},{id:'two',name:'Two'}],
      async resolveModelInfo(provider,model){resolved.push(model);controller.abort();return {};}
    },
    agentDefaultModel:{currentSelection:()=>({provider:'selected',model:'one'})}
  };
  await assert.rejects(providerCatalog(ctx,'selected',controller.signal),error=>error.name==='AbortError');
  assert.deepEqual(resolved,['one']);
});
