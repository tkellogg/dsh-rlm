import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { resolve, join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

export function configuration(root, env = process.env) {
  const home = resolve(env.DSH_RLM_HOME || join(env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'dsh-rlm', 'user'));
  if (!env.DSH_RLM_PYTHON) throw new Error('Launch with uvx dsh-rlm or a uv tool installation; the Python entry point supplies its interpreter.');
  return { root, home, profile: join(home, 'profiles/web'),
    python: resolve(env.DSH_RLM_PYTHON),
    state: resolve(env.DSH_RLM_STATE_DIR || join(home, 'rlm-state')),
    node: join(root, 'runtime/node/bin/node'),
    dsh: join(root, 'app/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    patch: join(root, 'app/rlm.patch.yml') };
}
async function createOnce(path, content) {
  try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
export async function prepare(config) {
  await mkdir(config.profile, {recursive:true,mode:0o700});
  await mkdir(config.state, {recursive:true,mode:0o700});
  await createOnce(join(config.profile,'package.json'), JSON.stringify({name:'dsh-rlm-user-profile',private:true,
    dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}},null,2));
  await createOnce(join(config.profile,'cordis.patch.yml'), '[]\n');
}
export function launchEnvironment(config, env=process.env, setup=false) {
  // Never import a user's ordinary DSH profile implicitly.
  return {...env, DSH_HOME:config.home, DSH_RLM_PYTHON:config.python, DSH_RLM_STATE_DIR:config.state,
    DSH_RLM_SETUP:setup ? '1' : '', PATH: `${dirname(config.node)}${delimiter}${env.PATH || ''}`};
}
export function run(command,args,options) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:'inherit',...options});
    const listeners=['SIGINT','SIGTERM'].map(signal=>{const fn=()=>child.kill(signal);process.on(signal,fn);return [signal,fn]});
    const clean=()=>listeners.forEach(([signal,fn])=>process.off(signal,fn));
    child.once('error',error=>{clean();reject(error)});
    child.once('exit',(code,signal)=>{clean();resolve(code ?? (signal==='SIGINT'?130:1))});
  });
}
export async function main(args=process.argv.slice(2), root=resolve(dirname(fileURLToPath(import.meta.url)),'..')) {
  const command=args[0];
  if (command==='--help'||command==='-h'||command==='help') {
    console.log('DSH RLM — Python-native agents\n\nUsage: dsh-rlm [Web options]\n       dsh-rlm setup [Web options]\n       dsh-rlm doctor\n       uv tool upgrade dsh-rlm\n       dsh-rlm --version\n\nWeb options: --port NUMBER, --no-open, --host ADDRESS\nRuns in the current directory. State: DSH_RLM_HOME or ~/.local/share/dsh-rlm/user.');return 0;
  }
  const manifest=JSON.parse(await readFile(join(root,'release.json'),'utf8'));
  if(command==='--version'){console.log(`dsh-rlm ${manifest.version} (DSH ${manifest.dshVersion})`);return 0;}
  const config=configuration(root);
  if(command==='update') {
    console.log('Upgrade with uvx --upgrade dsh-rlm or uv tool upgrade dsh-rlm.');
    return 0;
  }
  if(command==='doctor') {
    let good=true;
    for(const [label,path] of Object.entries({node:config.node,python:config.python,dsh:config.dsh,profilePatch:config.patch})) {
      try{await access(path,constants.R_OK);console.log(`OK ${label}: ${path}`)}catch{good=false;console.log(`MISSING ${label}: ${path}`)}
    }
    const probe=spawnSync(config.python,['-c','import dsh_rlm, dill, pydantic; print("Python runtime imports OK")'],{encoding:'utf8'});
    if(probe.status!==0){good=false;console.log('Python runtime import check failed:',probe.error?.message || probe.stderr)}else console.log(probe.stdout.trim());
    console.log(`User data: ${config.home}\nWorkspace: ${process.cwd()}\nProvider authentication: inspect Settings → Models in the Web UI (doctor never reads secrets).`);
    return good?0:1;
  }
  if(command && command!=='setup' && !command.startsWith('--'))throw new Error(`Unknown command: ${command}`);
  const webArgs=command==='setup'?args.slice(1):args;
  for(let i=0;i<webArgs.length;i++) {
    if(['--no-open','--dump-config'].includes(webArgs[i]))continue;
    if(['--port','--host','--trusted-host'].includes(webArgs[i]) && webArgs[i+1] && !webArgs[i+1].startsWith('--')) {i++;continue;}
    throw new Error(`Unsupported Web option: ${webArgs[i]}`);
  }
  for(const path of [config.node,config.python,config.dsh,config.patch])await access(path,constants.R_OK);
  await prepare(config);
  if(command==='setup')console.log('Provider setup: open Settings → Setup to choose a provider, connect an account, and select your default model.');
  return run(config.node,[config.dsh,'web','--patch',config.patch,...webArgs],{env:launchEnvironment(config,process.env,command==='setup'),cwd:process.cwd()});
}
if(process.argv[1] && realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url)))main().then(code=>{process.exitCode=code},error=>{console.error(`dsh-rlm: ${error.message}`);process.exitCode=1});
