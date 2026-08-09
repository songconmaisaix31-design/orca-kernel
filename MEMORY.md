# Project Memory

## Project

- Repository: `stablyai/orca`
- Baseline for this worktree: tag `v1.4.175` at commit `c762b2d1f0021e37f144fc3e1eff4d69afd632ba`
- Package manager: pnpm
- Primary languages: TypeScript, React, Electron, Node.js

## Architecture

- The frontend lives in `src/renderer/` and is built for both Electron and the browser.
- Electron backend code lives in `src/main/`; remote runtime and relay code remain backend concerns.
- `src/preload/api-types.ts` is the renderer-facing API contract. Electron installs that contract through the preload bridge; the browser implementation is installed by `src/renderer/src/web/web-preload-api.ts` and forwards remote operations through the runtime client.
- Browser-safe domain types and pure logic live in `src/shared/`. Shared code must remain usable by the Web build.
- Remote client and host versions can differ. Changes to RPC parameters, stream frames, or published content must follow `docs/reference/remote-wire-compatibility.md`.

## Frontend Workflow

- Start the browser frontend: `pnpm dev:web`
- Type-check frontend code: `pnpm typecheck:web`
- Build the standalone Web client: `pnpm build:web`
- Run the complete frontend gate: `pnpm check:frontend`

## Decisions

### 2026-08-10: Preserve the existing monorepo boundary

The renderer and runtime remain in one repository. A separate deployable REST backend is not introduced because Orca already supports Electron IPC and paired WebSocket runtimes through one typed frontend contract. The frontend boundary is enforced instead: production renderer modules may use browser-safe shared code and the preload type contract, but may not import Electron, Node built-ins, `src/main`, or preload implementations.

## Operational Notes

- Pairing offers and runtime credentials are sensitive. Do not place them in source, documentation, logs, fixtures, or this file.
- Frontend work must still cover desktop, paired Web, SSH, and folder-workspace behavior where the changed surface applies.
