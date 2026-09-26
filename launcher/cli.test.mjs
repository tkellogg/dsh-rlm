import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuration,prepare,launchEnvironment,main} from './cli.mjs';
test('isolated home ignores ordinary DSH_HOME and selects private runtimes',()=>{
 const c=configuration('/release',{DSH_HOME:'/existing',XDG_DATA_HOME:'/data',DSH_RLM_PYTHON:'/uv/python'});
 assert.equal(c.home,'/data/dsh-rlm/user');assert.equal(c.python,'/uv/python');
 const e=launchEnvironment(c,{DSH_HOME:'/existing',PATH:'/bin'});assert.equal(e.DSH_HOME,c.home);assert.equal(e.DSH_RLM_STATE_DIR,c.state);assert.equal(e.PATH,'/release/runtime/node/bin:/bin');
});
test('explicit runtime overrides supported',()=>{const c=configuration('/release',{DSH_RLM_HOME:'/mine',DSH_RLM_PYTHON:'/python',DSH_RLM_STATE_DIR:'/state'});assert.equal(c.home,'/mine');assert.equal(c.python,'/python');assert.equal(c.state,'/state')});
test('profile initialization is repeatable and preserves user config',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rlm-launch-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const c=configuration('/release',{DSH_RLM_HOME:dir,DSH_RLM_PYTHON:'/uv/python'});await prepare(c);
 assert.deepEqual(JSON.parse(await readFile(join(c.profile,'package.json'),'utf8')).dsh.profile.bundles,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']);
 await writeFile(join(c.profile,'cordis.patch.yml'),'# user\n[]\n');await prepare(c);assert.equal(await readFile(join(c.profile,'cordis.patch.yml'),'utf8'),'# user\n[]\n');
});
test('help needs no installation or filesystem mutation',async()=>{assert.equal(await main(['--help'],'/nonexistent'),0)});
