import test from 'node:test';
import assert from 'node:assert/strict';
import {validateProductMetadata} from '../src/lib/productOptions.js';
test('packaging factors respect bounds and stock precision',()=>{
 for(const factor of [0.0001,1000001,1.2345])assert.throws(()=>validateProductMetadata({packaging:[{unit:'quti',factor,salePrice:1}]}));
 assert.doesNotThrow(()=>validateProductMetadata({packaging:[{unit:'quti',factor:1.001,salePrice:1}]}));
});
test('packaging rejects repeated unit',()=>{
 assert.throws(()=>validateProductMetadata({packaging:[{unit:'quti',factor:24,salePrice:1},{unit:'quti',factor:12,salePrice:2}]}));
});
