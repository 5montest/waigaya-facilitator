import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOpenAIKey } from '../src/credentials.js';

test('承認したキーのファイルをメモリへ読み、曖昧な複数キー・リンクを拒否', () => {
  const root=mkdtempSync(join(tmpdir(),'waigaya-key-test-')); const value='sk-'+ 'example'.repeat(6);
  try {
    writeFileSync(join(root,'key.txt'),value); const env={OPENAI_API_KEY_FILE:'key.txt'};
    assert.deepEqual(loadOpenAIKey({workspace:root,env}),{configured:true,source:'file'}); assert.equal(env.OPENAI_API_KEY,value);
    symlinkSync(join(root,'key.txt'),join(root,'link.txt'));
    assert.throws(()=>loadOpenAIKey({workspace:root,env:{OPENAI_API_KEY_FILE:'link.txt'}}));
    writeFileSync(join(root,'multiple.txt'),value+'\n'+value+'x');
    assert.throws(()=>loadOpenAIKey({workspace:root,env:{OPENAI_API_KEY_FILE:'multiple.txt'}}));
    assert.throws(()=>loadOpenAIKey({workspace:root,env:{OPENAI_API_KEY_FILE:'../outside.txt'}}));
  } finally { rmSync(root,{recursive:true}); }
});
