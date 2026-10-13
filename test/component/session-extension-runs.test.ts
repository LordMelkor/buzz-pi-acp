import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function setup() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  return { conn, proc, session }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

// A turn that never completes must fail the test rather than hang it.
function within<T>(p: Promise<T>, ms = 100): Promise<T | 'pending'> {
  return Promise.race([p, new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), ms))])
}

function agentText(conn: FakeAgentSideConnection, from = 0): string {
  return conn.updates
    .slice(from)
    .map(u => u.update)
    .flatMap(u => (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' ? [u.content.text] : []))
    .join('')
}

function runningStates(conn: FakeAgentSideConnection): unknown[] {
  return conn.updates
    .map(u => u.update)
    .flatMap(u =>
      u.sessionUpdate === 'session_info_update' ? [(u._meta?.piAcp as { running?: unknown }).running] : []
    )
}

function runPi(proc: FakePiRpcProcess, text: string) {
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
}

test('a prompt during an extension-started run waits for it, then runs as its own turn', async () => {
  const { conn, proc, session } = setup()

  proc.emit({ type: 'agent_start' })
  await tick()
  assert.deepEqual(runningStates(conn), [true])

  const reply = session.prompt('User question')
  await tick()
  assert.deepEqual(proc.prompts, [])
  assert.match(agentText(conn), /Queued message \(position 1\)/)

  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Subagent report' } })
  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.deepEqual(proc.prompts, [{ message: 'User question', attachments: [] }])
  assert.equal(await within(reply, 20), 'pending')

  const turnStart = conn.updates.length
  runPi(proc, 'Answer to the user')
  assert.equal(await within(reply), 'end_turn')
  assert.equal(agentText(conn, turnStart), 'Answer to the user')

  await tick()
  const later = session.prompt('Later question')
  await tick()
  assert.deepEqual(proc.prompts.at(-1), { message: 'Later question', attachments: [] })
  runPi(proc, 'Later answer')
  assert.equal(await within(later), 'end_turn')
})

test('prompts queued during an extension-started run keep their order when another arrives as it settles', async () => {
  const { proc, session } = setup()

  proc.emit({ type: 'agent_start' })
  const first = session.prompt('first')
  await tick()
  proc.emit({ type: 'agent_settled' })
  const second = session.prompt('second')
  await tick()
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['first']
  )

  runPi(proc, 'First answer')
  assert.equal(await within(first), 'end_turn')
  await tick()
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['first', 'second']
  )
  runPi(proc, 'Second answer')
  assert.equal(await within(second), 'end_turn')
})

test('an extension run that starts as a turn settles keeps the session running and holds queued prompts', async () => {
  const { conn, proc, session } = setup()

  const first = session.prompt('first')
  const second = session.prompt('second')
  await tick()
  runPi(proc, 'First answer')
  proc.emit({ type: 'agent_start' })
  assert.equal(await within(first), 'end_turn')
  await tick()
  assert.equal(runningStates(conn).at(-1), true)
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['first']
  )

  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['first', 'second']
  )
  runPi(proc, 'Second answer')
  assert.equal(await within(second), 'end_turn')
  await tick()
  assert.equal(runningStates(conn).at(-1), false)
})

test('a prompt Pi queues behind a run the adapter has not seen yet resolves on that run', async () => {
  const { conn, proc, session } = setup()
  proc.promptDispositions.push('queued')

  const reply = session.prompt('User question')
  await tick()
  assert.deepEqual(proc.promptStreamingBehaviors, ['followUp'])
  assert.equal(await within(reply, 20), 'pending')

  const turnStart = conn.updates.length
  runPi(proc, 'Answer to the user')
  assert.equal(await within(reply), 'end_turn')
  assert.equal(agentText(conn, turnStart), 'Answer to the user')
})

test('a prompt Pi reports as handled completes without a run and starts the next prompt', async () => {
  const { conn, proc, session } = setup()
  proc.promptDispositions.push('handled')

  const handled = session.prompt('Handled by an extension')
  const next = session.prompt('Next question')

  assert.equal(await within(handled), 'end_turn')
  await tick()
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['Handled by an extension', 'Next question']
  )

  runPi(proc, 'Answer')
  assert.equal(await within(next), 'end_turn')
  await tick()
  assert.equal(runningStates(conn).at(-1), false)
})

test('cancel during an extension-started run cancels queued prompts and starts nothing after it', async () => {
  const { proc, session } = setup()

  proc.emit({ type: 'agent_start' })
  const first = session.prompt('one')
  const second = session.prompt('two')

  await session.cancel()
  assert.equal(await within(first), 'cancelled')
  assert.equal(await within(second), 'cancelled')
  assert.equal(proc.abortCount, 1)

  proc.emit({ type: 'agent_settled', aborted: true })
  await tick()
  assert.deepEqual(proc.prompts, [])
})

test('cancel drops a prompt Pi queued as a follow-up so it does not run after the abort', async () => {
  const { proc, session } = setup()
  proc.promptDispositions.push('queued')

  const reply = session.prompt('User question')
  await tick()
  await session.cancel()
  assert.deepEqual(proc.calls, ['clear_queue', 'abort'])

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled', aborted: true })
  assert.equal(await within(reply), 'cancelled')
})

test('cancel before Pi reports a prompt queued still drops the follow-up', async () => {
  const { proc, session } = setup()
  proc.promptDispositions.push('queued')

  const reply = session.prompt('User question')
  await session.cancel()
  await tick()
  assert.ok(proc.calls.includes('clear_queue'))

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled', aborted: true })
  assert.equal(await within(reply), 'cancelled')
})

test('a prompt sent as an extension-started run settles is not completed by that settle', async () => {
  const { proc, session } = setup()

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  const reply = session.prompt('User question')
  await tick()
  assert.deepEqual(proc.prompts, [{ message: 'User question', attachments: [] }])
  assert.equal(await within(reply, 20), 'pending')

  runPi(proc, 'Answer')
  assert.equal(await within(reply), 'end_turn')
})
