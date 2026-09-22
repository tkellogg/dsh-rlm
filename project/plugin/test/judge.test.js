import assert from 'node:assert/strict'
import test from 'node:test'
import { JevClient, JevError } from '../lib/judge.js'

const request = { state: { text: 'urgent' }, questions: {
  route: { type: 'choice', instructions: 'Route', criteria: { act: 'Act', ignore: 'Ignore' } },
  urgency: { type: 'noul', instructions: 'Urgent?' },
} }

test('Jev is a no-op without credentials', async () => {
  let calls=0; const client=new JevClient({apiKey:' ',fetch:async()=>{calls++; throw new Error()} })
  assert.equal(await client.judge(request),null); assert.equal(calls,0)
})

test('Jev serializes one structured request and validates response', async () => {
  let seen
  const client=new JevClient({apiKey:'secret',fetch:async (url,init)=>{ seen={url,init}; return new Response(JSON.stringify({model:'jev-1.13.0',answers:{route:{type:'choice',choice:'act',probabilities:{act:.8,ignore:.2},confidence:.7},urgency:{type:'noul',noul:.9}},usage:{input_tokens:10,output_tokens:4}}),{status:200,headers:{'Content-Type':'application/json'}}) }})
  const result=await client.judge(request); assert.equal(result.model,'jev-1.13.0'); assert.equal(result.answers.urgency.noul,.9)
  assert.equal(seen.url,'https://api.typesafe.ai/v1/systemone'); assert.equal(seen.init.headers.Authorization,'Bearer secret')
  assert.deepEqual(JSON.parse(seen.init.body),{...request,model:'jev-latest'})
})

test('configured failures are typed; safeJudge returns null', async () => {
  const client=new JevClient({apiKey:'secret',fetch:async()=>new Response('',{status:429})})
  await assert.rejects(client.judge(request), error => error instanceof JevError && error.code==='RATE_LIMIT')
  assert.equal(await client.safeJudge(request),null)
})

test('invalid requests fail before fetch', async () => {
  const client=new JevClient({apiKey:'secret',fetch:async()=>{throw new Error('must not run')}})
  await assert.rejects(client.judge({state:{},questions:{}}), error => error instanceof JevError && error.code==='INVALID_REQUEST')
})
