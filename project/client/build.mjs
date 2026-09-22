import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Script } from "node:vm";
const source = await readFile(new URL("./src/client.bundle.js", import.meta.url), "utf8");
new Script(source, { filename: "client.bundle.js" });
await mkdir(new URL("./lib/", import.meta.url), { recursive: true });
await writeFile(new URL("./lib/client.js", import.meta.url), source);
await writeFile(new URL("./lib/index.js", import.meta.url), "/** Host half is intentionally empty; UI is in ./client.js. */\nexport const name = '@dsh-rlm/jev-settings';\nexport function apply() {}\n");
await writeFile(new URL("./lib/index.d.ts", import.meta.url), "export declare const name: string;\nexport declare function apply(): void;\n");
console.log("built lib/index.js and lib/client.js");
