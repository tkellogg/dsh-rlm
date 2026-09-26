// Offline launcher installation contracts. No server, npm, Python, or network is used.
// Run: node --test scripts/release-test-launcher.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, cp, rename, rm, symlink, stat, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const source = fileURLToPath(new URL('../launcher/cli.mjs', import.meta.url));
async function fixture(t) {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'rlm-install-contract-')));
  t.after(() => rm(work, {recursive:true, force:true}));
  const original = join(work, 'original');
  const root = join(work, 'relocated app with spaces');
  await mkdir(join(original, 'launcher'), {recursive:true});
  await cp(source, join(original, 'launcher/cli.mjs'));
  await writeFile(join(original, 'release.json'), JSON.stringify({version:'0.1.0', dshVersion:'test'}));
  await mkdir(join(original, 'runtime/node/bin'), {recursive:true});
  await symlink(process.execPath, join(original, 'runtime/node/bin/node'));
  await mkdir(join(original, 'app/node_modules/@deepseek-ai/dsh/lib'), {recursive:true});
  await writeFile(join(original, 'app/rlm.patch.yml'), '[]\n');
  // A transport spy, NOT a claim that real DSH booted. --dump-config must not start a server.
  await writeFile(join(original, 'app/node_modules/@deepseek-ai/dsh/lib/bin.js'), `
    console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),
      home:process.env.DSH_HOME,python:process.env.DSH_RLM_PYTHON,
      state:process.env.DSH_RLM_STATE_DIR,setup:process.env.DSH_RLM_SETUP,path:process.env.PATH}));
  `);
  await rename(original, root);
  const home = join(work, 'private user');
  const cwd = join(work, 'user workspace');
  await mkdir(cwd);
  const env = {HOME:join(work,'empty-home'), XDG_DATA_HOME:join(work,'data'),
    DSH_RLM_HOME:home, DSH_RLM_PYTHON:process.execPath,
    DSH_HOME:join(work,'ordinary-dsh'), PATH:''};
  const run = (args, overrides={}) => spawnSync(process.execPath,
    [join(root,'launcher/cli.mjs'), ...args], {cwd, env:{...env,...overrides},encoding:'utf8'});
  return {work,root,home,cwd,env,run};
}
test('relocated installation launches with an empty PATH and isolated profile', async t => {
  const f=await fixture(t); const result=f.run(['--dump-config']);
  assert.equal(result.status,0,result.stderr);
  const call=JSON.parse(result.stdout);
  assert.deepEqual(call.args,['web','--patch',join(f.root,'app/rlm.patch.yml'),'--dump-config']);
  assert.equal(call.cwd,f.cwd); assert.equal(call.home,f.home);
  assert.equal(call.python,process.execPath);
  assert.equal(call.state,join(f.home,'rlm-state'));
  assert.equal(call.path,join(f.root,'runtime/node/bin')+':');
  await assert.rejects(stat(f.env.DSH_HOME),{code:'ENOENT'});
});
test('repeated setup preserves user profile, settings, credentials and file permissions', async t => {
  const f=await fixture(t); assert.equal(f.run(['--dump-config']).status,0);
  const profile=join(f.home,'profiles/web');
  const files = [join(profile,'package.json'),join(profile,'cordis.patch.yml'),
    join(f.home,'settings.json'),join(f.home,'credentials.json')];
  for (const [i,path] of files.entries()) await writeFile(path,`preserved ${i}\n`,{mode:0o600});
  const result=f.run(['setup','--dump-config']); assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).setup,'1');
  for (const [i,path] of files.entries()) {
    assert.equal(await readFile(path,'utf8'),`preserved ${i}\n`);
    assert.equal((await stat(path)).mode & 0o777,0o600);
  }
});
test('missing installation components fail before writing a user profile', async t => {
  for (const relative of ['runtime/node/bin/node','app/node_modules/@deepseek-ai/dsh/lib/bin.js','app/rlm.patch.yml']) {
    const f=await fixture(t); await rm(join(f.root,relative));
    const result=f.run(['--dump-config']); assert.equal(result.status,1);
    assert.match(result.stderr,/ENOENT/); await assert.rejects(stat(f.home),{code:'ENOENT'});
  }
});
test('symlinked install root executes rather than silently returning success', async t => {
  const f=await fixture(t); const alias=join(f.work,'current app');
  await symlink(f.root,alias);
  const result=spawnSync(process.execPath,[join(alias,'launcher/cli.mjs'),'--version'],
    {cwd:f.cwd,env:f.env,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/dsh-rlm 0\.1\.0/);
});
test('unknown options and absent Python interpreter contract fail closed', async t => {
  const f=await fixture(t);
  for (const args of [['--exec','arbitrary'],['--port'],['unexpected']]) {
    assert.equal(f.run(args).status,1); await assert.rejects(stat(f.home),{code:'ENOENT'});
  }
  const result=f.run(['--dump-config'],{DSH_RLM_PYTHON:''});
  assert.equal(result.status,1); assert.match(result.stderr,/Python entry point/);
  await assert.rejects(stat(f.home),{code:'ENOENT'});
});
