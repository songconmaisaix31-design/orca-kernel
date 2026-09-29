import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

const PANE_KEY = makePaneKey('tab-authority', '11111111-1111-4111-8111-111111111111')
const SECOND_PANE_KEY = makePaneKey('tab-authority-2', '22222222-2222-4222-8222-222222222222')

function writeNamespacedAuthority(
  userDataPath: string,
  namespace: string,
  authorityCommitments: Record<string, unknown>
): void {
  const namespacePath = join(userDataPath, 'agent-hooks', namespace)
  mkdirSync(namespacePath, { recursive: true })
  writeFileSync(
    join(namespacePath, 'last-status.json'),
    JSON.stringify({ version: 2, entries: {}, authorityCommitments })
  )
}

describe('AgentHookServer authority evidence', () => {
  const servers: AgentHookServer[] = []

  afterEach(() => {
    for (const server of servers) {
      server.stop()
    }
    servers.length = 0
  })

  it('freezes pre-listen commitments separately from current-runtime observations', async () => {
    const server = new AgentHookServer()
    servers.push(server)
    const hydrated = {
      paneKey: PANE_KEY,
      launchToken: 'launch-before-restart',
      tabId: 'tab-authority',
      worktreeId: 'repo::before',
      connectionId: 'ssh-target',
      payload: { state: 'working', prompt: 'before', agentType: 'codex' },
      receivedAt: 100,
      stateStartedAt: 100
    } satisfies AgentHookEventPayload & { receivedAt: number; stateStartedAt: number }
    server._getStateForTests().lastStatusByPaneKey.set(PANE_KEY, hydrated)

    await server.start()
    const commitments = server.getHydratedAuthorityCommitments()

    expect(commitments).toEqual([
      {
        paneKey: PANE_KEY,
        launchTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        tabId: 'tab-authority',
        worktreeId: 'repo::before',
        connectionId: 'ssh-target',
        observedAt: 100
      }
    ])
    expect(Object.isFrozen(commitments)).toBe(true)
    expect(Object.isFrozen(commitments[0])).toBe(true)
    expect(server.getCurrentAuthorityObservations()).toEqual([])
    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-before-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toEqual({ paneKey: PANE_KEY, source: 'hydrated_commitment' })

    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        launchToken: 'launch-after-restart',
        tabId: 'tab-authority',
        worktreeId: 'repo::after',
        payload: { state: 'working', prompt: 'after', agentType: 'codex' }
      },
      'ssh-target'
    )

    expect(server.getHydratedAuthorityCommitments()).toBe(commitments)
    expect(JSON.stringify(commitments)).not.toContain('launch-before-restart')
    expect(server.getCurrentAuthorityObservations()).toEqual([
      expect.objectContaining({
        paneKey: PANE_KEY,
        launchTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        connectionId: 'ssh-target',
        worktreeId: 'repo::after'
      })
    ])
    expect(JSON.stringify(server.getCurrentAuthorityObservations())).not.toContain(
      'launch-after-restart'
    )
    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-before-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toBeNull()
    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-before-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'current_runtime'
      })
    ).toBeNull()

    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-after-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toBeNull()
    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-after-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'current_runtime'
      })
    ).toEqual({ paneKey: PANE_KEY, source: 'current_hook' })

    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        launchToken: 'launch-before-restart',
        tabId: 'tab-authority',
        worktreeId: 'repo::current',
        payload: { state: 'working', prompt: 'current', agentType: 'codex' }
      },
      'ssh-target'
    )

    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-before-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toEqual({ paneKey: PANE_KEY, source: 'current_hook' })

    server.ingestRemote(
      {
        paneKey: SECOND_PANE_KEY,
        launchToken: 'launch-before-restart',
        tabId: 'tab-authority-2',
        payload: { state: 'working', prompt: 'duplicate', agentType: 'codex' }
      },
      'ssh-target'
    )

    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-before-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toBeNull()

    server.clearStatusEntriesForConnection('ssh-target')

    expect(server.getHydratedAuthorityCommitments()).toBe(commitments)
    expect(server.getCurrentAuthorityObservations()).toEqual([])
    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-before-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toEqual({ paneKey: PANE_KEY, source: 'hydrated_commitment' })

    server.clearPaneState(PANE_KEY)

    expect(server.getHydratedAuthorityCommitments()).toBe(commitments)
    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-before-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toBeNull()
  })

  it('preserves hydrated authority when stale alias cleanup does not own the stable pane', async () => {
    const server = new AgentHookServer()
    servers.push(server)
    const launchToken = 'launch-before-restart'
    const launchTokenHash = createHash('sha256').update(launchToken).digest('hex')
    const hydrated = {
      paneKey: PANE_KEY,
      launchToken,
      tabId: 'tab-authority',
      worktreeId: 'repo::before',
      connectionId: 'ssh-target',
      payload: { state: 'working', prompt: 'before', agentType: 'codex' },
      receivedAt: 100,
      stateStartedAt: 100
    } satisfies AgentHookEventPayload & { receivedAt: number; stateStartedAt: number }
    server._getStateForTests().lastStatusByPaneKey.set(PANE_KEY, hydrated)
    server.registerPaneKeyAlias('tab-authority:0', PANE_KEY, 'old-pty')
    await server.start()
    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        launchToken,
        tabId: 'tab-authority',
        worktreeId: 'repo::current',
        payload: { state: 'working', prompt: 'current', agentType: 'codex' }
      },
      'ssh-target'
    )

    server.clearPaneKeyAliasesForPty('old-pty', { shouldClearStablePaneKey: () => false })

    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash,
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toEqual({ paneKey: PANE_KEY, source: 'current_hook' })
  })

  it('hydrates restored authority from a prior dev namespace in the same profile', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-hook-authority-'))
    const launchTokenHash = createHash('sha256').update('retained-dev-launch').digest('hex')
    const commitment = {
      paneKey: PANE_KEY,
      launchTokenHash,
      connectionId: null,
      tabId: 'tab-authority',
      worktreeId: 'repo::before',
      observedAt: Date.now()
    }
    writeNamespacedAuthority(userDataPath, 'com.stablyai.orca.dev.1111111111', {
      [PANE_KEY]: commitment
    })
    writeNamespacedAuthority(userDataPath, 'com.stablyai.orca.dev.2222222222', {
      [PANE_KEY]: commitment
    })
    const server = new AgentHookServer()
    servers.push(server)
    try {
      await server.start({ env: 'production', userDataPath })

      expect(
        server.attestCompatibilityAuthority({
          paneKey: PANE_KEY,
          launchTokenHash,
          connectionId: null,
          terminalProvenance: 'restored'
        })
      ).toEqual({ paneKey: PANE_KEY, source: 'hydrated_commitment' })
      expect(
        server.attestCompatibilityAuthority({
          paneKey: PANE_KEY,
          launchTokenHash,
          connectionId: null,
          terminalProvenance: 'current_runtime'
        })
      ).toBeNull()
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('rejects conflicting legacy namespaces instead of choosing one', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-hook-authority-conflict-'))
    const firstHash = createHash('sha256').update('first-launch').digest('hex')
    const secondHash = createHash('sha256').update('second-launch').digest('hex')
    const authority = (launchTokenHash: string) => ({
      paneKey: PANE_KEY,
      launchTokenHash,
      connectionId: null,
      observedAt: Date.now()
    })
    writeNamespacedAuthority(userDataPath, 'com.stablyai.orca.dev.1111111111', {
      [PANE_KEY]: authority(firstHash)
    })
    writeNamespacedAuthority(userDataPath, 'com.stablyai.orca.dev.2222222222', {
      [PANE_KEY]: authority(secondHash)
    })
    const server = new AgentHookServer()
    servers.push(server)
    try {
      await server.start({ env: 'production', userDataPath })

      for (const launchTokenHash of [firstHash, secondHash]) {
        expect(
          server.attestCompatibilityAuthority({
            paneKey: PANE_KEY,
            launchTokenHash,
            connectionId: null,
            terminalProvenance: 'restored'
          })
        ).toBeNull()
      }
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('keeps dev namespaces isolated from sibling authority', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-hook-authority-invalid-'))
    const launchTokenHash = createHash('sha256').update('isolated-launch').digest('hex')
    writeNamespacedAuthority(userDataPath, 'com.stablyai.orca.dev.1111111111', {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        launchTokenHash,
        connectionId: null,
        observedAt: Date.now()
      },
      [SECOND_PANE_KEY]: {
        paneKey: SECOND_PANE_KEY,
        launchTokenHash: 'not-a-hash',
        connectionId: null,
        observedAt: Date.now()
      }
    })
    const server = new AgentHookServer()
    servers.push(server)
    try {
      await server.start({
        env: 'development',
        userDataPath,
        endpointNamespace: 'dev-current'
      })

      expect(server.getHydratedAuthorityCommitments()).toEqual([])
      expect(
        server.attestCompatibilityAuthority({
          paneKey: PANE_KEY,
          launchTokenHash,
          connectionId: null,
          terminalProvenance: 'restored'
        })
      ).toBeNull()
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('ignores malformed and stale legacy commitments', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-hook-authority-invalid-'))
    const launchTokenHash = createHash('sha256').update('stale-launch').digest('hex')
    writeNamespacedAuthority(userDataPath, 'com.stablyai.orca.dev.1111111111', {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        launchTokenHash: 'not-a-hash',
        connectionId: null,
        observedAt: Date.now()
      },
      [SECOND_PANE_KEY]: {
        paneKey: SECOND_PANE_KEY,
        launchTokenHash,
        connectionId: null,
        observedAt: 1
      }
    })
    const server = new AgentHookServer()
    servers.push(server)
    try {
      await server.start({ env: 'production', userDataPath })

      expect(server.getHydratedAuthorityCommitments()).toEqual([])
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
