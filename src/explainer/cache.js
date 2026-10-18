import { readFile,writeFile,rename,mkdir,open,unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
export function defaultCacheFile() {
  let root=process.cwd();
  try { root=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch {}
  return join(resolve(process.env.ERRORBOOK_DIR || join(root,'.errorbook')),'local','explanation-cache.json');
}
export const cacheKey=event=>createHash('sha256').update(JSON.stringify([event.normalizationVersion,event.errorId,event.normalizedError,'v1'])).digest('hex');
export function createCache(file) {
  async function read(){try{const data=JSON.parse(await readFile(file,'utf8'));return data?.schemaVersion===1&&data.entries&&typeof data.entries==='object'&&!Array.isArray(data.entries)?data:{schemaVersion:1,entries:{}};}catch{return {schemaVersion:1,entries:{}};}}
  return {async get(event){return (await read()).entries[cacheKey(event)];},async put(event,value){await mkdir(dirname(file),{recursive:true});await writeFile(join(dirname(file),'.gitignore'),'*\n');let lock;try{lock=await open(file+'.lock','wx');}catch{return false;}try{const data=await read();data.entries[cacheKey(event)]=value;await writeFile(file+'.tmp',JSON.stringify(data,null,2)+'\n');await rename(file+'.tmp',file);return true;}finally{await lock.close();await unlink(file+'.lock');}}};
}
