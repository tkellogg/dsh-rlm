import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { JevService, Config, validateSettings } from '../lib/jev-service.js'
import { createHostCallbackDispatcher, createHostCallbackExecution } from '../lib/host-callbacks.js'

const turn = () => new Promise(resolve => setImmediate(resolve))
class MemorySettings extends SettingsProvider {
  writable = true
  async load() { return {} }
  async persist() {}
}
class MemoryCredentials extends CredentialProvider {
  key = undefined
  async resolve() { return this.key ? {value: this.key, source: 'file'} : undefined }
  async describe() { return {configured: Boolean(this.key), writable: true, ...(this.key ? {source:'file'} : {})} }
}
const request = {state: {word:'hello'}, questions:{greeting:{type:'choice',criteria:{greeting:'Greeting',other:'Other'}}}}
async function fixture() {
  const ctx = new Context()
  ctx.plugin(MemorySettings)
  ctx.plugin(MemoryCredentials)
  const calls = []
  const transport = async (url, init) => {
    calls.push({url, init})
    return Response.json({model:'jev-test',answers:{greeting:{type:'choice',choice:'greeting',probabilities:{greeting:1,other:0},confidence:1}}})
  }
  const fork = ctx.plugin(context => { new JevService(context, {}, transport) })
  await turn(); await turn()
  return {ctx, calls, fork}
}

test('Jev settings register with credential reference, live changes and secret-free status', async () => {
  const {ctx,calls,fork} = await fixture()
  try {
    const descriptor = ctx.settings.describe({redactSecrets:true}).find(d=>d.ns==='jev')
    assert.ok(descriptor)
    assert.match(JSON.stringify(descriptor.schema), /credential-ref/)
    assert.equal((await ctx.jev.status()).state, 'not-configured')
    assert.equal(await ctx.jev.judge(request),null)
    assert.equal(calls.length,0)
    ctx.credentials.key='test-secret-one'
    assert.equal((await ctx.jev.status()).credentialSource,'file')
    assert.doesNotMatch(JSON.stringify(await ctx.jev.status()), /test-secret/)
    await ctx.settings.update('jev',{model:'jev-custom',timeoutMs:5000})
    await ctx.jev.judge(request)
    assert.equal(JSON.parse(calls[0].init.body).model,'jev-custom')
    assert.equal(calls[0].init.headers.Authorization,'Bearer test-secret-one')
    ctx.credentials.key='test-secret-two'
    await ctx.jev.judge(request)
    assert.equal(calls[1].init.headers.Authorization,'Bearer test-secret-two')
    await ctx.settings.update('jev',{enabled:false})
    assert.equal((await ctx.jev.status()).state,'disabled')
    assert.equal(await ctx.jev.judge(request),null)
    assert.equal((await ctx.jev.testConnection()).code,'disabled')
    assert.equal(calls.length,2)
    await assert.rejects(ctx.settings.update('jev',{baseURL:'http://unsafe.example'}))
    assert.equal(ctx.settings.get('jev').baseURL,'https://api.typesafe.ai')
  } finally { await fork.dispose() }
})

test('connection test sends fixed input and redacts errors', async () => {
  const {ctx,calls,fork} = await fixture()
  try {
    ctx.credentials.key='test-secret'
    assert.equal((await ctx.jev.testConnection()).ok,true)
    const body=JSON.parse(calls[0].init.body)
    assert.deepEqual(body.state,{purpose:'Jev connection test',word:'hello'})
    assert.equal(calls.length,1)
    ctx.credentials.resolve=async()=>{throw new Error('test-secret private details')}
    const failure=await ctx.jev.testConnection()
    assert.equal(failure.ok,false)
    assert.doesNotMatch(JSON.stringify(failure),/test-secret|private details/)
  } finally { await fork.dispose() }
})

test('RLM callbacks share Jev service and normalize nullable bridge options', async () => {
  const {ctx,calls,fork}=await fixture()
  try {
    ctx.credentials.key='test-secret'
    const agent={id:'test-agent'}
    const host={get:name=>ctx.get(name), agents:{get:()=>agent,withInitiator:async(_a,fn)=>await fn()}}
    const dispatcher=createHostCallbackDispatcher(host)
    const signal=new AbortController().signal
    const frame={kind:'callback',id:'judge-1',parent_id:'cell',method:'judge.judge',params:{...request,model:null,timeout_ms:null,safe:false}}
    const execution=createHostCallbackExecution({agent,signal})
    assert.equal((await dispatcher.dispatch(frame,execution,signal)).model,'jev-test')
    await ctx.settings.update('jev',{enabled:false})
    assert.equal(await dispatcher.dispatch(frame,execution,signal),null)
    assert.equal(calls.length,1)
  } finally { await fork.dispose() }
})

test('invalid endpoints rejected without exposing URL secrets', () => {
  for(const baseURL of ['http://example.com','https://user:password@example.com','https://example.com/path','https://example.com?key=secret']) {
    assert.throws(()=>validateSettings({...Config({}),baseURL}), error=>!error.message.includes('password')&&!error.message.includes('key=secret'))
  }
})

test('service disposal unregisters settings and refuses captured calls', async () => {
  const {ctx,fork}=await fixture()
  const service=ctx.jev
  await fork.dispose()
  await turn()
  assert.equal(ctx.get('jev'),undefined)
  assert.equal(ctx.settings.get('jev'),undefined)
  await assert.rejects(service.judge(request))
})

test('absent optional service returns no decision without invoking an ambient client', async () => {
  const agent={id:'test-agent'}
  const host={get:()=>undefined,agents:{get:()=>agent,withInitiator:async(_a,fn)=>await fn()}}
  const signal=new AbortController().signal
  const dispatcher=createHostCallbackDispatcher(host)
  assert.equal(await dispatcher.dispatch({kind:'callback',id:'j',parent_id:'cell',method:'judge.judge',params:{...request,model:null,timeout_ms:null,safe:false}},createHostCallbackExecution({agent,signal}),signal),null)
})

test('safe judging still rejects caller errors and cancellation', async () => {
  const {ctx,fork}=await fixture()
  try {
    ctx.credentials.key='test-secret'
    await assert.rejects(ctx.jev.safeJudge({state:{},questions:{}}),{code:'INVALID_REQUEST'})
    const control=new AbortController(); control.abort()
    await assert.rejects(ctx.jev.safeJudge(request,control.signal))
  } finally { await fork.dispose() }
})

test('disable during credential resolution prevents a late request', async () => {
  const {ctx,calls,fork}=await fixture()
  let release
  ctx.credentials.resolve=()=>new Promise(resolve=>{release=resolve})
  try {
    const pending=ctx.jev.judge(request)
    await ctx.settings.update('jev',{enabled:false})
    release({value:'test-secret',source:'file'})
    assert.equal(await pending,null)
    assert.equal(calls.length,0)
  } finally { await fork.dispose() }
})

test('public Gateway discovers only the two plugin Remote endpoints', async () => {
  const { TypertRegistry } = await import('@deepseek-ai/dsh-typert-registry')
  const { TypertGatewayService } = await import('@deepseek-ai/dsh-api-gateway')
  const { JevRemote } = await import('../lib/jev-remote.js')
  const {ctx,calls,fork}=await fixture()
  const registry=ctx.plugin(TypertRegistry)
  const gateway=ctx.plugin(TypertGatewayService,{websocketHeartbeatIntervalMs:2000})
  const remote=ctx.plugin(JevRemote)
  await turn(); await turn()
  try {
    const status=await ctx.typertGateway.invoke({namespace:'jev',method:'status',args:{}})
    assert.equal(status.state,'not-configured')
    await assert.rejects(ctx.typertGateway.invoke({namespace:'jev',method:'judge',args:{}}))
    await assert.rejects(ctx.typertGateway.invoke({namespace:'jev',method:'testConnection',args:{state:'do not transmit'}}))
    assert.equal(calls.length,0)
    ctx.credentials.key='test-secret'
    const result=await ctx.typertGateway.invoke({namespace:'jev',method:'testConnection',args:{}})
    assert.equal(result.ok,true)
    assert.equal(calls.length,1)
    await remote.dispose()
    await assert.rejects(ctx.typertGateway.invoke({namespace:'jev',method:'status',args:{}}))
  } finally { await remote.dispose(); await gateway.dispose(); await registry.dispose(); await fork.dispose() }
})

test('browser RPC envelope reaches the plugin through public Connection interception', async () => {
  const {Service}=await import('@deepseek-ai/cordis')
  const {TypertRegistry}=await import('@deepseek-ai/dsh-typert-registry')
  const {TypertGatewayService}=await import('@deepseek-ai/dsh-api-gateway')
  const {JevRemote}=await import('../lib/jev-remote.js')
  let intercept
  class Connection extends Service {
    constructor(ctx) { super(ctx,'connection') }
    rpc={intercept:(channel,matches,handler)=>{intercept={channel,matches,handler};return async()=>{intercept=undefined}}}
  }
  const {ctx,fork}=await fixture()
  const connection=ctx.plugin(Connection)
  const registry=ctx.plugin(TypertRegistry)
  const gateway=ctx.plugin(TypertGatewayService,{websocketHeartbeatIntervalMs:2000})
  const remote=ctx.plugin(JevRemote)
  await turn(); await turn()
  try {
    assert.equal(intercept.channel,'/api')
    assert.equal(intercept.matches('jev/status'),true)
    const signal=new AbortController().signal
    const result=await intercept.handler('jev/status',{args:{}},signal)
    assert.equal(result.ok,true)
    assert.equal(result.value.state,'not-configured')
    assert.equal((await intercept.handler('jev/status',{},signal)).ok,false)
  } finally { await remote.dispose(); await gateway.dispose(); await registry.dispose(); await connection.dispose(); await fork.dispose() }
})

test('trusted launch fallback is used only when credentials provider is absent', async () => {
  const {createLaunchEnvironmentSnapshot}=await import('@deepseek-ai/dsh-launch-environment')
  const ctx=new Context()
  ctx.provide('launchEnvironment')
  ctx.set('launchEnvironment',createLaunchEnvironmentSnapshot([{source:'process',values:{TYPESAFE_API_KEY:'ambient-secret'}}]))
  const calls=[]
  const fork=ctx.plugin(context=>{ new JevService(context,{},async(_url,init)=>{
    calls.push(init.headers.Authorization)
    return Response.json({model:'jev-test',answers:{greeting:{type:'choice',choice:'greeting',confidence:1,probabilities:{greeting:1,other:0}}}})
  }) })
  await turn()
  let credentials
  try {
    assert.equal((await ctx.jev.status()).credentialSource,'process')
    await ctx.jev.judge(request)
    assert.deepEqual(calls,['Bearer ambient-secret'])
    credentials=ctx.plugin(MemoryCredentials)
    await turn()
    assert.equal((await ctx.jev.status()).state,'not-configured')
    assert.equal(await ctx.jev.judge(request),null)
    assert.equal(calls.length,1)
  } finally { await credentials?.dispose(); await fork.dispose() }
})

test('credential exceptions are redacted for judge and status', async () => {
  const {ctx,fork}=await fixture()
  try {
    ctx.credentials.resolve=async()=>{throw new Error('secret-token-private')}
    ctx.credentials.describe=async()=>{throw new Error('secret-token-private')}
    for (const operation of [()=>ctx.jev.judge(request),()=>ctx.jev.status()]) {
      await assert.rejects(operation(),error=>error.code==='AUTH'&&!String(error).includes('secret-token'))
    }
    assert.equal(await ctx.jev.safeJudge(request),null)
  } finally {await fork.dispose()}
})

test('pending credential inspection cancels and test busy state clears', async () => {
  const {ctx,fork}=await fixture()
  try {
    ctx.credentials.describe=()=>new Promise(()=>{})
    const control=new AbortController()
    const pending=ctx.jev.testConnection(control.signal)
    control.abort()
    await assert.rejects(pending,{code:'ABORTED'})
    ctx.credentials.describe=async()=>({configured:false,writable:true})
    assert.equal((await ctx.jev.testConnection()).code,'not-configured')
  } finally {await fork.dispose()}
})

test('changed endpoint during credential resolution does not send stale credentials', async () => {
  const {ctx,calls,fork}=await fixture()
  let release
  ctx.credentials.resolve=()=>new Promise(resolve=>{release=resolve})
  try {
    const pending=ctx.jev.judge(request)
    await turn()
    await ctx.settings.update('jev',{baseURL:'https://other.example'})
    release({value:'secret',source:'file'})
    assert.equal(await pending,null)
    assert.equal(calls.length,0)
  } finally {await fork.dispose()}
})
