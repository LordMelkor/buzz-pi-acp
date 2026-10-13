import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly permissionRequests: unknown[] = []
  nextPermissionResponse: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } = {
    outcome: { outcome: 'selected', optionId: 'allow' }
  }

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  async requestPermission(
    params: unknown
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly steers: Array<{ message: string; attachments: unknown[] }> = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  readonly promptStreamingBehaviors: Array<'steer' | 'followUp' | undefined> = []
  // Dispositions pi answers prompts with, in order; 'started' once exhausted.
  readonly promptDispositions: Array<'started' | 'queued' | 'handled'> = []

  async prompt(
    message: string,
    attachments: unknown[] = [],
    streamingBehavior?: 'steer' | 'followUp'
  ): Promise<'started' | 'queued' | 'handled'> {
    this.prompts.push({ message, attachments })
    this.promptStreamingBehaviors.push(streamingBehavior)
    return this.promptDispositions.shift() ?? 'started'
  }

  // Models pi's steering queue: `steer` enqueues, `consumeSteers` drains it into the
  // run, and `clearQueue` returns and removes whatever pi did not consume.
  readonly steeringQueue: string[] = []
  readonly consumed: string[] = []
  readonly calls: string[] = []
  // Messages an input extension handles, so pi never queues them.
  readonly handledByExtension = new Set<string>()

  async steer(message: string, attachments: unknown[] = []): Promise<'queued' | 'handled'> {
    this.steers.push({ message, attachments })
    if (this.handledByExtension.has(message)) return 'handled'
    this.steeringQueue.push(message)
    return 'queued'
  }

  consumeSteers(): void {
    this.consumed.push(...this.steeringQueue.splice(0))
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    this.calls.push('clear_queue')
    return { steering: this.steeringQueue.splice(0), followUp: [] }
  }

  async abort(): Promise<void> {
    this.calls.push('abort')
    this.abortCount += 1
  }

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  async getState(): Promise<any> {
    return {}
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AgentSideConnection
}
