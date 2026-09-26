// Assemble a release with all JS dependencies installed; no npm on user machines.
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const source=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const stage=resolve(process.argv[2] || 'dist/stage');
const version=process.env.VERSION || '0.1.0';
if(!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))throw new Error('Invalid VERSION');
// Resolve registry selectors once; record concrete versions in the payload.
const dshSelector=process.env.DSH_VERSION || 'latest';
const subscriptionsSelector=process.env.SUBSCRIPTIONS_VERSION || 'latest';
function registryVersion(name,selector){
  if(!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(selector))throw new Error(`Invalid version/tag selector for ${name}: ${selector}`);
  const r=spawnSync('npm',['view',`${name}@${selector}`,'version','--json'],{cwd:source,encoding:'utf8'});
  if(r.error)throw r.error;
  if(r.status!==0)throw new Error(r.stderr || `Cannot resolve ${name}@${selector}`);
  const value=JSON.parse(r.stdout);
  if(typeof value!=='string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value))throw new Error(`Selector must resolve one version: ${name}@${selector}`);
  return value;
}
const dshVersion=registryVersion('@deepseek-ai/dsh',dshSelector);
const subscriptionsVersion=registryVersion('dsh-plugin-subscriptions',subscriptionsSelector);
console.log(`Building DSH ${dshSelector} -> ${dshVersion}; subscriptions ${subscriptionsSelector} -> ${subscriptionsVersion}`);
function command(exe,args,cwd){const r=spawnSync(exe,args,{cwd,stdio:'inherit'});if(r.error)throw r.error;if(r.status!==0)throw new Error(`${exe} failed (${r.status})`)}
await mkdir(join(stage,'app/packages'),{recursive:true});
for(const name of ['plugin','client','onboarding']){
  const from=join(source,'project',name),to=join(stage,'app/packages',name);
  const pkg=JSON.parse(await readFile(join(from,'package.json'),'utf8'));
  if (pkg.devDependencies || pkg.dependencies) command('npm',['ci','--no-audit','--no-fund'],from);
  if(pkg.scripts?.build)command('npm',['run','build'],from);
  // npm pack respects the package files allowlist and verifies publish shape.
  await mkdir(to,{recursive:true});
  const result=spawnSync('npm',['pack','--ignore-scripts','--json','--pack-destination',join(stage,'app/packages')],{cwd:from,encoding:'utf8'});
  if(result.status!==0)throw new Error(result.stderr || 'npm pack failed');
  const archive=JSON.parse(result.stdout)[0].filename;
  command('tar',['-xzf',join(stage,'app/packages',archive),'--strip-components=1','-C',to],source);
}
// Explicitly select every plugin host peer; npm otherwise prefers the newer alpha
// from the compatibility union even when the requested host is the latest rc.
const pluginManifest=JSON.parse(await readFile(join(source,'project/plugin/package.json'),'utf8'));
const hostPeers=Object.fromEntries(Object.keys(pluginManifest.peerDependencies).filter(name=>name.startsWith('@deepseek-ai/dsh-')).map(name=>[name,dshVersion]));
await writeFile(join(stage,'app/package.json'),JSON.stringify({name:'dsh-rlm-distribution',version,private:true,type:'module',dependencies:{
  ...hostPeers,
  '@deepseek-ai/dsh':dshVersion,'dsh-plugin-subscriptions':subscriptionsVersion,
  // Select a single host API set without bypassing plugin peer compatibility checks.
  '@deepseek-ai/dsh-brand':dshVersion,'@deepseek-ai/dsh-user-approval':dshVersion,
  '@deepseek-ai/dsh-llm':dshVersion,'@deepseek-ai/dsh-tools':dshVersion,
  '@deepseek-ai/dsh-attachment':dshVersion,'@deepseek-ai/dsh-home-paths':dshVersion,
  '@dsh-rlm/plugin':'file:packages/plugin','@dsh-rlm/jev-settings':'file:packages/client','@dsh-rlm/onboarding':'file:packages/onboarding'
},overrides:{
  '@deepseek-ai/cordis':'4.0.2',
  '@deepseek-ai/cordis-plugin-include':'1.0.7',
  '@deepseek-ai/cordis-plugin-loader':'1.0.3',
  '@deepseek-ai/cordis-plugin-group':'1.0.2',
  '@deepseek-ai/cordis-plugin-timer':'1.1.4'
}},null,2));
command('npm',['install','--install-links','--omit=dev','--no-audit','--no-fund'],join(stage,'app'));
// Patches remain relative to this file, so the release can move after assembly.
let patch='';
for(const [name,path] of [['plugin','cordis.patch.yml'],['onboarding','cordis.patch.yml']]){
  const original=await readFile(join(stage,'app/packages',name,path),'utf8');
  patch+=original.replace(/name: (['"]?)\.\//g,`name: $1./packages/${name}/`).replace('name: "@dsh-rlm/onboarding"', 'name: ./packages/onboarding/lib/index.js')+'\n';
}
patch+='\n- insert:\n    - id: dsh-jev-settings\n      name: ./packages/client/lib/index.js\n';
// Subscription bundle uses package specifiers/relative paths; preserve its origin by rewriting only relative modules.
const subscription=JSON.parse(await readFile(join(stage,'app/node_modules/dsh-plugin-subscriptions/package.json'),'utf8'));
const subPatch=subscription.dsh.bundle.patch;
const subBase=dirname(join('node_modules/dsh-plugin-subscriptions',subPatch));
patch+='\n'+(await readFile(join(stage,'app/node_modules/dsh-plugin-subscriptions',subPatch),'utf8')).replace(/name: (['"]?)\.\//g,`name: $1./${subBase}/`).replace('name: dsh-plugin-subscriptions', 'name: ./node_modules/dsh-plugin-subscriptions/lib/index.js')+'\n';
await writeFile(join(stage,'app/rlm.patch.yml'),patch);
await cp(join(source,'launcher'),join(stage,'launcher'),{recursive:true});
await writeFile(join(stage,'release.json'),JSON.stringify({version,dshVersion,dshSelector,subscriptionsVersion,subscriptionsSelector,pythonSource:'uv-tool-environment'},null,2));
console.log(`Assembled ${stage}`);
