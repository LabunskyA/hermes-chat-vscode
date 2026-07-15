# Hermes Multi-Agent Design

## Goal

Expose Hermes profiles as selectable agents inside the chat composer while preserving profile isolation and Hermes-native behavior.

## Terminology

- **Profile / Agent**: A persistent Hermes identity with its own model, provider, secrets, `SOUL.md`, memory, skills, sessions, cron jobs, and state database.
- **Subagent**: A temporary worker created by the active profile through `delegate_task`. It belongs to one parent turn and is not a persistent chat identity.
- **Workspace**: The VS Code folder available to the selected profile. It is independent of profile identity.

The chat selector represents **profiles**, not subagents.

## Current Hermes Capabilities

Hermes `0.18.2` supports persistent profiles:

```bash
hermes profile list
hermes profile create coder --clone --description "Coding specialist"
hermes -p coder acp
```

Named profiles live under `~/.hermes/profiles/<name>/`. The default profile lives at `~/.hermes`. Each profile has isolated configuration, secrets, personality, memory, sessions, skills, cron jobs, and runtime state.

Hermes also supports temporary subagent delegation through `delegate_task`, including parallel workers and orchestrator/leaf roles. Delegation should remain an automatic tool capability of the selected profile.

## Recommended UX

### Composer Agent Selector

Add a compact selector to the composer footer, before `Attach files`:

```text
[ Hermes · default ▾ ]  [ Attach files ]                 Workspace: project
```

The menu contains:

1. Current profile with model/provider summary.
2. Other profiles with description and model.
3. `Create new agent…`.
4. `Manage agents…`.

Switching profiles is disabled while a response is streaming. The user can stop the response first.

### Create Agent

Use a focused modal or Webview flow:

1. Agent name and description.
2. Start blank or clone an existing profile.
3. Choose provider/model or inherit cloned configuration.
4. Optionally edit `SOUL.md` after creation.

The first implementation should call Hermes-native commands rather than recreating profile creation logic:

```bash
hermes profile create <name> --clone-from <source> --description <description>
```

Provider setup then runs against the new profile.

### Subagent Activity

Do not list transient subagents in the profile selector. Render delegation as tool activity inside the assistant turn:

```text
Delegated 3 tasks
  ✓ Review API routes
  ◌ Inspect tests
  ✓ Check provider config
```

This can be added after profile selection because ACP already streams tool calls.

## Architecture

### Profile Discovery

Create a `ProfileStore` that reads:

- Default profile from `~/.hermes`.
- Named profiles from `~/.hermes/profiles/*`.
- Description from each `profile.yaml`.
- Model/provider from each `config.yaml`.

Avoid parsing the human-formatted `hermes profile list` table.

### ACP Process Selection

Extend `AcpClient` with an optional profile name. Spawn:

```text
default: hermes acp
named:   hermes -p <profile> acp
```

Selecting a different profile must stop the current ACP process before starting another one.

### Per-Profile State

Replace single global chat state with profile-scoped state:

```text
activeProfile
sessionIdByProfile[profile]
messagesByProfile[profile]
history entries include profile
attachments remain workspace-scoped
```

On switch:

1. Persist the current profile snapshot.
2. Stop its ACP client.
3. Set the selected profile.
4. Restore that profile's latest session and messages.
5. Start its ACP process lazily on the next prompt.

Never reuse one profile's session ID with another profile.

### Workspace Context

The selected profile can search and read the open VS Code workspace through ACP file tools. `Attach files` remains an explicit way to pin file contents into the prompt; it is not required for normal workspace access.

## Implementation Phases

### Phase 1 — Profile Selection

- Add `ProfileStore` and profile metadata types.
- Add profile argument support to `AcpClient`.
- Scope session and message state by profile.
- Add composer selector and switching behavior.
- Include profile identity in local history.

### Phase 2 — Profile Management

- Add create-agent flow using `hermes profile create`.
- Add clone/blank choices and description.
- Launch profile-scoped provider setup.
- Add rename, delete, and open profile files.

### Phase 3 — Delegation Visibility

- Detect `delegate_task` tool calls.
- Render child task names and statuses.
- Add optional delegation controls in Settings.

## Safety and Validation

- Reject profile names not matching Hermes naming rules.
- Never display or copy `.env` values.
- Confirm before deleting a profile.
- Block switching while processing unless the user stops the turn.
- Test default and named profile ACP spawning.
- Test that session/history data never crosses profile boundaries.
