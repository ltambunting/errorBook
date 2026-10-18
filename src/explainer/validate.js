export function validateExplanation(value) {
  if(!value||typeof value.explanation!=='string'||!value.explanation.trim()||value.explanation.length>10000)throw new Error('Invalid AI explanation format');
  for(const field of ['suggestedSteps','caveats'])if(!Array.isArray(value[field])||value[field].length>30||value[field].some(s=>typeof s!=='string'||s.length>5000))throw new Error(`Invalid AI ${field} format`);
  return {explanation:value.explanation,suggestedSteps:value.suggestedSteps,caveats:value.caveats};
}
