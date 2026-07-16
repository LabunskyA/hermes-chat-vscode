# Hermes ACP Capability Matrix

Verified against Hermes Agent ACP adapter commit `59787b9` on 2026-07-16. This matrix separates upstream protocol support from behavior currently exposed by the VS Code extension.

| Capability | Hermes ACP surface | Extension status | Next integration step |
| --- | --- | --- | --- |
| Create session | `session/new` | Supported and used | Keep as the new-chat path |
| Resume session | `session/resume` | Supported and used | Replace silent fallback with explicit migration UX |
| List sessions | `session/list` with `cwd` and cursor | Client contract and fake-server test added; no UI | Drive history from Hermes instead of `workspaceState` |
| Load session | `session/load` plus replayed `session/update` events | Client contract and replay-order test added; no UI | Rebuild chat history from ACP replay |
| Fork session | `session/fork` | Client contract and fake-server test added; no UI | Add fork action after Hermes-backed history lands |
| Cancel turn | `session/cancel` | Client support exists | Define profile-switch and background-turn policy |
| Select model | `session/set_model` and dynamic model state | Partially supported | Read advertised models before removing static tables |
| Select mode | `session/set_mode` and dynamic mode state | Not surfaced in chat UI | Implement read-side state before write controls |
| Configuration | ACP config options | Not capability-driven | Map advertised options into the settings page |
| Commands | Available slash-command updates | Not surfaced | Render commands from ACP declarations |
| Plan | Plan updates through `session/update` | Transport accepts updates; no semantic timeline | Add typed plan events to the turn timeline |
| Usage | Usage/session info updates | Usage updates rendered and reduced into turn state | Consolidate final and streaming usage semantics |
| Tool calls | Tool call and tool update events | Supported; reducer now owns turn state | Render typed timeline cards from the reducer model |
| Images | Image prompt content blocks | Upstream and initialize capability available | Replace text-only attachment conversion |
| Resources | Resource prompt content blocks | Upstream support verified; not used | Add native file/resource attachment path |

## Sequencing Constraints

- Keep existing `workspaceState` history until Hermes session listing/loading has a user-data migration path.
- Treat `session/load` replay as synchronous protocol output that can arrive before the request resolves.
- Introduce capability-driven controls read-first; do not assume every Hermes runtime advertises the same models, modes, commands, or prompt content.
- Add runtime pooling only after session ownership and in-flight cancellation behavior are explicit.
