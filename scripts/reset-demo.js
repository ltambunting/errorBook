import {writeFile,readFile,mkdir,realpath,lstat} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function resetDemo(){
  const demo=join(root,'demo/broken-project');await mkdir(demo,{recursive:true});
  if(await realpath(demo)!==demo)throw new Error('Refusing to reset a symbolic-link directory.');
  for(const name of ['app.js','unknown.js']){
    const text=await readFile(join(root,'demo/templates',name+'.txt'),'utf8');
    const path=join(demo,name);try{if((await lstat(path)).isSymbolicLink())throw new Error('Refusing to reset a symbolic-link file.');}catch(e){if(e.code!=='ENOENT')throw e;}
    await writeFile(path,text);
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){await resetDemo();console.log('Reset the two demo files. Saved fixes and cached explanations are preserved.');}
