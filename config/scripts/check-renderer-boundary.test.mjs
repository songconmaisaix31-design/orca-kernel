import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findRendererBoundaryViolations } from './check-renderer-boundary.mjs'

const temporaryRoots = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  )
})

async function writeFixture(root, relativePath, contents) {
  const targetPath = join(root, relativePath)
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, contents)
}

describe('renderer boundary check', () => {
  it('allows shared contracts and excludes test-only modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-renderer-boundary-'))
    temporaryRoots.push(root)
    await writeFixture(
      root,
      'src/renderer/src/app.ts',
      "import type { PreloadApi } from '../../preload/api-types'\nexport type { Repo } from '../../shared/types'\n"
    )
    await writeFixture(
      root,
      'src/renderer/src/parity-test-state.ts',
      "import { vi } from 'vitest'\nimport { deriveStatus } from '../../main/gitlab/mappers'\nexport const status = vi.fn(deriveStatus)\n"
    )

    await expect(findRendererBoundaryViolations(root)).resolves.toEqual([])
  })

  it('rejects backend modules through every import form', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-renderer-boundary-'))
    temporaryRoots.push(root)
    await writeFixture(
      root,
      'src/renderer/src/bad.ts',
      [
        "import backend from '../../main/backend'",
        "export { install } from '../../preload/index'",
        "const electron = import('electron')",
        "const fs = require('node:fs')",
        "import path from 'path'",
        "import '../../preload/api-types'"
      ].join('\n')
    )

    const violations = await findRendererBoundaryViolations(root)

    expect(violations.map(({ specifier }) => specifier)).toEqual([
      '../../main/backend',
      '../../preload/index',
      'electron',
      'node:fs',
      'path',
      '../../preload/api-types'
    ])
  })
})
