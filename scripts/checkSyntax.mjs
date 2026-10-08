import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Check every server module, not only the hand-maintained list in package.json.
function files(directory) {
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const full=join(directory,entry.name);
    if(entry.isDirectory())return files(full);
    return entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)?[full]:[];
  });
}
const modules=[...files('src'),...files('scripts')];
for(const modulePath of modules){
  const result=spawnSync(process.execPath,['--check',modulePath],{encoding:'utf8'});
  if(result.status!==0){
    process.stderr.write(`Syntax failure in ${modulePath}\n${result.stderr||result.stdout}`);
    process.exit(1);
  }
}
console.log(`Syntax OK: ${modules.length} backend JS modules`);
