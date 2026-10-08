// Wire-compatible full snapshots for initial/resync connections; indexed deltas thereafter.
export const partFields = ['utterances','minutesHistory','usage','contextMemory','aiTurns','publications'];
export function stateMessage(state, cache, { volatile = false } = {}) {
  if (!cache.state) { cache.state = JSON.parse(JSON.stringify(state)); return { type:'state',state:cache.state }; }
  const previous=cache.state,baseSequence=previous.sequence,set={},arrays={};
  for(const [key,value] of Object.entries(state)) {
    if(partFields.includes(key)&&Array.isArray(value)) {
      if(volatile&&key!=='aiTurns')continue;
      const before=previous[key]||[],entries=[];
      const from=volatile&&key==='aiTurns'?Math.max(0,value.length-1):0;
      for(let index=from;index<value.length;index++)if(JSON.stringify(value[index])!==JSON.stringify(before[index]))entries.push({index,value:JSON.parse(JSON.stringify(value[index]))});
      if(entries.length||value.length!==before.length){arrays[key]={length:value.length,entries};previous[key]=before.slice(0,value.length);for(const e of entries)previous[key][e.index]=e.value;}
    }else if(JSON.stringify(value)!==JSON.stringify(previous[key])) {set[key]=value===undefined?null:JSON.parse(JSON.stringify(value));previous[key]=set[key];}
  }
  return {type:'state_patch',baseSequence,sequence:state.sequence,set,arrays};
}
export function applyStatePatch(state,event) {
  if(event.sequence<=(state?.sequence??-1))return state;
  if(!state||state.sequence!==event.baseSequence)throw new Error('state resync required');
  const next={...state,...event.set,sequence:event.sequence};
  for(const [key,delta] of Object.entries(event.arrays)) {next[key]=(state[key]||[]).slice(0,delta.length);for(const {index,value} of delta.entries)next[key][index]=value;}
  return next;
}
