import test from 'node:test';
import assert from 'node:assert/strict';
import {aiRuntimeSettings} from '../src/config/ai.js';
test('AI configuration errors disable only AI runtime',()=>{
 const settings=aiRuntimeSettings({ZENIX_AI_MODEL:'unpriced-model',OPENAI_API_KEY:'must-not-leak',ZENIX_AI_ENABLED:'true'});
 assert.equal(settings.enabled,false);assert.equal(settings.writesEnabled,false);assert.equal(settings.configurationError,'AI_CONFIG_INVALID');assert.equal(settings.apiKey,'');
 const good=aiRuntimeSettings({ZENIX_AI_MODEL:'gpt-6-luna'});assert.equal(good.model,'gpt-6-luna');assert.equal(good.enabled,false);
});
