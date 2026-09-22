import assert from 'node:assert/strict'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {Loader} from '@deepseek-ai/cordis-plugin-loader'
import {ClientModuleRegistry} from '@deepseek-ai/dsh-client-modules'

const turn=()=>new Promise(resolve=>setImmediate(resolve))
test('ordinary Loader entry discovers Jev client metadata and serves its browser artifact', async () => {
  const ctx=new Context()
  const loaderFork=ctx.plugin(Loader,{baseUrl:new URL('../profile/',import.meta.url).href})
  await turn()
  await ctx.loader.create({name:new URL('../../client/lib/index.js',import.meta.url).href})
  await ctx.loader.await()
  const modulesFork=ctx.plugin(ClientModuleRegistry)
  await turn()
  try {
    assert.equal(ctx.clientModules.clientPath('@dsh-rlm/jev-settings'),fileURLToPath(new URL('../../client/lib/client.js',import.meta.url)))
    const graph=ctx.clientModules.graph()
    assert.match(JSON.stringify(graph),/@dsh-rlm\/jev-settings/)
  } finally { await modulesFork.dispose(); await loaderFork.dispose() }
})
