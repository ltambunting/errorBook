import {createInterface} from 'node:readline';
export function createPrompts({input=process.stdin,output=process.stdout}={}) {
  const interactive=Boolean(input.isTTY&&output.isTTY);
  let rl,closed=false;
  function ensure(){if(!rl){rl=createInterface({input,output});rl.on('close',()=>{closed=true;});}}
  async function ask(text){if(!interactive||closed)return '';ensure();return new Promise(resolve=>{const onClose=()=>resolve('');rl.once('close',onClose);rl.question(text,answer=>{rl.removeListener('close',onClose);resolve(answer.trim());});});}
  return {interactive,ask,async yes(text){return /^(y|yes)$/i.test(await ask(`${text} [y/n] `));},close(){rl?.close();}};
}
