import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

test(
  'prompt sends streamingBehavior and returns the disposition pi reports',
  { skip: process.platform === 'win32' },
  async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-prompt-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const executable = join(root, 'fake-pi')
    // Answers each prompt with the disposition named by its message ('none' omits it).
    writeFileSync(
      executable,
      `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const cmd = JSON.parse(line);
  let data = {};
  if (cmd.type === 'prompt') {
    fs.appendFileSync('prompts.jsonl', line + '\\n');
    if (cmd.message !== 'none') data = { disposition: cmd.message };
  }
  console.log(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
});
`,
      { mode: 0o700 }
    )
    const proc = await PiRpcProcess.spawn({ cwd: root, piCommand: executable })
    try {
      assert.equal(await proc.prompt('handled', [], 'followUp'), 'handled')
      assert.equal(await proc.prompt('queued', [], 'followUp'), 'queued')
      assert.equal(await proc.prompt('none'), 'started')
    } finally {
      proc.dispose()
    }
    const sent = readFileSync(join(root, 'prompts.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map(line => (JSON.parse(line) as { streamingBehavior?: string }).streamingBehavior)
    assert.deepEqual(sent, ['followUp', 'followUp', undefined])
  }
)
