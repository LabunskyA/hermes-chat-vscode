# Multi-Agent Decision Map

## #1: What Is Selectable In Chat?

Blocked by: none
Status: resolved
Type: Research

### Question

Should the chat selector represent Hermes profiles or transient subagents?

### Answer

Profiles are persistent, isolated agent identities and belong in the selector. Subagents are temporary `delegate_task` workers and should appear as activity inside a turn.

## #2: How Should Profile Switching Preserve State?

Blocked by: #1
Status: resolved
Type: Prototype

### Question

Validate the proposed profile-scoped session/message/history state and switching sequence against ACP resume behavior.

### Answer

Implemented profile-scoped session IDs, message snapshots, history filtering, ACP process restart, and lazy resume. Named profiles launch with `hermes -p <profile> acp`; the default launches with `hermes acp`.

## #3: What Is The Minimum Create-Agent Flow?

Blocked by: #1
Status: resolved
Type: Grilling

### Question

Should v1 create only cloned agents, or support blank and cloned profiles with provider setup?

### Answer

Version 1 supports both blank creation and cloning from any existing profile. It captures name and role description, then opens profile-scoped Hermes setup for provider/model configuration.

## #4: How Much Delegation Detail Should The UI Show?

Blocked by: #2
Status: open
Type: Prototype

### Question

Determine which ACP tool events expose enough information for child-task status without coupling to Hermes internals.

### Answer

Pending prototype.
