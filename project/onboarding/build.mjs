import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Script } from 'node:vm';
const source = await readFile(new URL('./src/client.bundle.js', import.meta.url), 'utf8');
const host = await readFile(new URL('./src/index.js', import.meta.url), 'utf8');
new Script(source);
await mkdir(new URL('./lib/', import.meta.url), { recursive: true });
await writeFile(new URL('./lib/client.js', import.meta.url), source);
await writeFile(new URL('./lib/index.js', import.meta.url), host);
