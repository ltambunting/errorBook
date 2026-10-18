import {mkdtemp,readFile,mkdir,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dir=await mkdtemp(join(tmpdir(),'errorbook-demo-'));
try {
 const data=join(dir,'.errorbook');await mkdir(join(data,'local'),{recursive:true});
 const events=JSON.parse(await readFile(join(root,'demo/fixtures/events.json'),'utf8'));
 for(const author of new Set(events.map(e=>e.author)))await writeFile(join(data,`${author}.jsonl`),events.filter(e=>e.author===author).map(e=>JSON.stringify(e)).join('\n')+'\n');
 await writeFile(join(data,'local/.gitignore'),'*\n');
 await copyFile(join(root,'demo/fixtures/explanation-cache.json'),join(data,'local/explanation-cache.json'));
 const file=process.argv[2]==='unknown'?'unknown.js':'app.js';
 console.log('Temporary demo workspace: changes will be discarded after this run.');
 process.exitCode=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[join(root,'bin/errorbook.js'),'run','--offline','--',process.execPath,join(root,'demo/broken-project',file)],{cwd:dir,env:{...process.env,ERRORBOOK_DIR:data},stdio:'inherit'});child.on('error',reject);child.on('close',code=>resolve(code??1));});
} finally {await rm(dir,{recursive:true,force:true});}
