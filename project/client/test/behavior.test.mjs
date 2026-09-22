import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'

async function fixture() {
  let registration
  vm.runInNewContext(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:r=>registration=r}},AbortController,URL,console})
  const store=value=>({getSnapshot:()=>value,set:next=>{value=next},subscribe:()=>()=>{}})
  const api=registration.factory(name=>name==='react'?{}:{createSnapshotStore:store})
  let saved={enabled:true,apiKeyEnv:'TYPESAFE_API_KEY',model:'jev-latest',timeoutMs:10000,baseURL:'https://api.typesafe.ai'}
  let snapshot={status:'ready',value:saved,writable:true,revision:1,mode:'host'}
  const listeners=new Set(), calls=[]
  let rejectSave=false, configured=false
  const scope={getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},mutate:async ops=>{
    if(!rejectSave){saved={...saved};for(const op of ops)saved[op.path[0]]=op.value;snapshot={...snapshot,value:saved,revision:snapshot.revision+1}}
    for(const fn of listeners)fn()
  }}
  const ctx={settingsScope:{bind:()=>scope},connection:{rpc:{call:async(channel,endpoint,payload)=>{
    calls.push({channel,endpoint,payload})
    return {ok:true,value:endpoint==='jev/status'?{state:configured?'configured':'not-configured',credentialSource:configured?'file':null,model:saved.model,baseURL:saved.baseURL}:{ok:true,code:'OK',message:'Connection verified'}}
  }}},remote:{credentials:{describe:async refs=>({ok:true,value:Object.fromEntries(refs.map(ref=>[ref,{configured,writable:true}]))}),set:async(ref,value)=>{calls.push({ref,value});configured=true;return{ok:true}},unset:async()=>{configured=false;return{ok:true}}}}}
  const controller=new api.JevController(ctx)
  return {controller,calls,ctx,getSaved:()=>saved,reject:()=>{rejectSave=true}}
}

test('opening page reads metadata but never tests provider; dirty state blocks test',async()=>{
  const {controller:c,calls}=await fixture()
  await c.readStatus();await c.readCredential()
  assert.equal(c.projection().canTest,false)
  assert.equal(calls.some(x=>x.endpoint==='jev/testConnection'),false)
  await c.saveSecret('sample-secret')
  assert.equal(c.projection().canTest,true)
  assert.doesNotMatch(JSON.stringify(c.projection()),/sample-secret/)
  c.edit('model','jev-other')
  assert.equal(c.projection().canTest,false)
  await c.testConnection()
  assert.equal(calls.some(x=>x.endpoint==='jev/testConnection'),false)
  c.discard();await c.testConnection()
  assert.equal(calls.filter(x=>x.endpoint==='jev/testConnection').length,1)
  c.dispose()
})

test('save persists normalized settings and rejected save retains draft and error',async()=>{
  const {controller:c,getSaved,reject}=await fixture()
  c.edit('timeoutMs','2000');await c.save()
  assert.equal(getSaved().timeoutMs,2000)
  assert.equal(c.projection().dirty,false)
  reject();c.edit('model','rejected-model');await c.save()
  assert.equal(c.projection().model,'rejected-model')
  assert.equal(c.projection().failed,true)
  assert.equal(c.projection().dirty,true)
  c.dispose()
})

test('secrets are not written to an unsaved credential reference',async()=>{
  const {controller:c,calls}=await fixture()
  await c.readCredential();c.edit('apiKeyEnv','NEW_KEY')
  await c.saveSecret('must-not-send')
  assert.equal(calls.some(x=>x.value==='must-not-send'),false)
  assert.doesNotMatch(JSON.stringify(c.projection()),/must-not-send/)
  c.dispose()
})

test('settings slot registers, renders controls, and disposes using public hooks',async()=>{
  let registration,section,seat
  const cleanups=[]
  vm.runInNewContext(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:r=>registration=r}},AbortController,URL,console})
  const react={createElement:(type,props,...children)=>({type,props,children}),useState:v=>[v,()=>{}],useRef:v=>({current:v}),useEffect:()=>{}}
  const store=value=>({getSnapshot:()=>value,set:next=>{value=next},subscribe:()=>()=>{}})
  const api=registration.factory(name=>name==='react'?react:{createSnapshotStore:store})
  const scope={getSnapshot:()=>({status:'ready',value:{enabled:true,apiKeyEnv:'TYPESAFE_API_KEY',model:'jev-latest',timeoutMs:10000,baseURL:'https://api.typesafe.ai'},writable:true}),subscribe:()=>()=>{}}
  const ctx={settingsScope:{bind:()=>scope},connection:{rpc:{}},remote:{credentials:{}},locale:{register:()=>()=>{},bind:()=>()=> 'Jev Judge'},on:()=>()=>{},effect:fn=>{cleanups.push(fn())},slots:{inject:(_key,fn)=>{cleanups.push(fn())},register:(entry,component)=>{seat=entry;section=component;return()=>{seat=null}}}}
  api.apply(ctx)
  assert.equal(seat.name,'settings.section')
  assert.equal(seat.label(),'Jev Judge')
  const face=seat.inject()
  const tree=section({...face,useJev:fn=>fn(face.hooks.jev.getSnapshot())})
  const rendered=JSON.stringify(tree)
  for(const label of ['Jev Judge','Advanced endpoint','Test connection','Save secret','Remove secret'])assert.match(rendered,new RegExp(label))
  assert.match(rendered,/password/)
  for(const dispose of cleanups.reverse())if(typeof dispose==='function')dispose()
  assert.equal(seat,null)
})
