# Frontend and Runtime Boundary

Status: Implemented

Date: 2026-08-10

Baseline: Orca `v1.4.175`

## Problem

Frontend changes need a stable development boundary. Orca already builds the same React renderer for Electron and for a paired browser client, but the boundary is implicit across build configuration and transport adapters. A future renderer import from Electron, Node.js, or backend implementation code could silently couple the frontend back to one host.

## Goals

- Keep `src/renderer/` independently type-checkable and Web-buildable.
- Keep one renderer-facing contract across Electron and paired Web runtimes.
- Fail early when production renderer code imports backend-only modules.
- Provide one command that verifies the frontend before UI work is handed off.

## Non-goals

- Splitting Orca into multiple repositories.
- Introducing an HTTP or REST backend alongside the existing runtime protocol.
- Changing RPC payloads, pairing, authentication, persistence, or UI behavior.
- Mocking the full runtime for offline product flows.

## Terms and Ownership

| Term            | Owner                                                                      | Location                                  |
| --------------- | -------------------------------------------------------------------------- | ----------------------------------------- |
| Frontend        | React renderer shared by desktop and Web                                   | `src/renderer/`                           |
| Desktop adapter | Electron preload implementation of the frontend contract                   | `src/preload/`                            |
| Web adapter     | Browser implementation of the frontend contract                            | `src/renderer/src/web/web-preload-api.ts` |
| Backend         | Electron main process, runtime services, relays, PTY and host integrations | `src/main/`, `src/relay/`                 |
| Shared contract | Browser-safe types and protocol definitions                                | `src/preload/api-types.ts`, `src/shared/` |

## Architecture

```text
React renderer
    |
    | PreloadApi
    |
    +-- Electron preload adapter --> Electron main/runtime
    |
    +-- Web preload adapter ------> paired WebSocket runtime
```

The renderer owns presentation and local UI state. Host capabilities, filesystem access, processes, Git operations, credentials, and persistence stay behind the contract. Browser-safe shared code may be imported directly; host implementations may not.

## API Contract

`PreloadApi` in `src/preload/api-types.ts` remains the single renderer-facing contract.

- Electron exposes the contract through the preload bridge.
- The browser installs the same contract shape through `installWebPreloadApi()`.
- Renderer modules may use only type imports from `src/preload/api-types.ts` as the contract seam.
- Renderer modules must not import other `src/preload/` files, `src/main/`, `electron`, or `node:*` modules.
- Wire changes must remain compatible with independently updated clients and hosts. Additive optional fields are preferred; new stream operations require capability negotiation.

No API or wire-format change is part of this work.

## Implementation

1. Add a static renderer-boundary check over production source files.
2. Exclude test files and modules importing Vitest because some parity tests intentionally exercise main-process pure functions.
3. Run the boundary check from the repository lint gate.
4. Add `pnpm check:frontend` to run the boundary check, Web type-check, and Web build.

## Acceptance Criteria

- `pnpm check:renderer-boundary` passes on the baseline source.
- The checker rejects direct, re-exported, required, and dynamically imported backend-only modules.
- Existing renderer tests that import pure main-process modules remain supported.
- `pnpm typecheck:web` passes.
- `pnpm build:web` creates a verified standalone Web client.
- No production application behavior or remote wire contract changes.

## Risks

- A source-only boundary check does not prove runtime compatibility; the Web build remains required.
- Test-only backend imports can hide poor test placement, so exclusions are limited to conventional test files and modules that explicitly import Vitest.
- Shared modules can still become browser-incompatible. The independent Web build is the final guard for transitive dependencies.

## Verification

```bash
pnpm exec vitest run --config config/vitest.config.ts config/scripts/check-renderer-boundary.test.mjs
pnpm check:frontend
```

Both commands passed on Windows against the `v1.4.175` baseline on 2026-08-10.
