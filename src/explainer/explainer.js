import {createCache} from './cache.js';
import {aiAdapter} from './aiAdapter.js';
import {validateExplanation} from './validate.js';
export function createExplainer({cacheFile,provider=aiAdapter}) {
  const cache=createCache(cacheFile);
  return {async explain(event,{offline=false}={}){
    if (!event?.errorId || !event.normalizedError || !event.normalizationVersion) return {status:'unavailable',reason:'invalid_input',message:'A fingerprinted error context is required.'};
    const saved=await cache.get(event);
    if(saved)try{return {status:'ok',source:'cache',value:validateExplanation(saved)};}catch{}
    if(offline)return {status:'unavailable',reason:'offline',message:'Offline mode is enabled and no cached explanation is available.'};
    try {
      const raw=await provider(event);let value;
      try{value=validateExplanation(raw);}catch(e){e.reason='invalid_response';throw e;}
      let cached=false;try{cached=await cache.put(event,value);}catch{}
      return {status:'ok',source:'live',value,cacheSaved:cached};
    }catch(e){return {status:'unavailable',reason:e.reason||'provider_error',message:e.message};}
  }};
}
