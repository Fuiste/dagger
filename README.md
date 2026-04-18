# dagger

`dagger` v1 is an event-sourced DAG execution engine for existing agent chats.

It does not create plans. It runs supplied YAML DAG plans, routes model tasks to Codex or Cursor according to task role and runtime profile, records append-only run events, and keeps intermediate artifacts structured instead of turning the whole run into one long prose braid.

## What It Is Good At

- delegating a separable slice of work to a better-suited model
- preserving observability, cache reuse, and resumability across repeated runs
- producing structured design, review, extraction, and validation artifacts for the current chat thread to consume

The canonical example is a full site redesign where the current Codex thread keeps business logic ownership while Dagger delegates the design subtree to Opus through Cursor and returns implementation-oriented artifacts.

## Quick Start

```sh
bun install
bun test
dagger run examples/site-redesign.plan.yaml --dry-run
dagger run examples/site-redesign.plan.yaml --profile balanced --max-concurrency 3
```

## CLI

```sh
dagger run path/to/plan.yaml \
  --profile balanced \
  --max-concurrency 3 \
  --events pretty
```

Important flags:

- `--dry-run`: validate the plan shape, show execution levels, and show routed model tasks.
- `--resume`: continue the last unfinished run for the same plan digest.
- `--artifacts-dir PATH`: relocate run logs, projections, transcripts, and cache metadata.

## Plan Format

Plans are YAML and versioned:

```yaml
version: 1
defaults:
  profile: balanced
tasks:
  - id: design-direction
    kind: model
    role: designer
    prompt: Produce an implementation-oriented redesign direction.
    outputs:
      - id: design_spec
        path: .dagger/generated/design-spec.json
        format: json
```

Supported task kinds:

- `model`
- `command`
- `reduce`
- `assert`

See [docs/v1-plan-format.md](docs/v1-plan-format.md) for the full format and [examples/site-redesign.plan.yaml](examples/site-redesign.plan.yaml) for the intended “design subtree delegated out of the current chat” example.

## Skill

This repo ships a repo-local skill at [SKILL.md](SKILL.md). Point an agent at it when you want help deciding:

- whether Dagger is actually a win
- how to author a good DAG plan
- which roles to use
- when a task should stay in the current thread instead

## Runtime Model Routing

Balanced defaults:

- `designer` -> Cursor `claude-opus-4-7-thinking-high`
- `frontend_implementer` -> Codex `gpt-5.4`
- `backend_implementer` -> Codex `gpt-5.4`
- `reviewer` -> Codex `gpt-5.4`
- `cheap_reader` -> Cursor `composer-2`

Plans can override provider or model per task, but the default design is role-first rather than vendor-first.

## Architecture

- append-only events live in `.dagger/runs/<runId>/events.ndjson`
- projections derive task state, artifacts, timings, and usage totals
- transcripts are stored per task for observability
- cache entries are keyed by task definition plus declared inputs plus runtime profile

The old markdown graph and benchmark harness are still present in this repo for historical comparison and internal measurement, but the public v1 surface is `dagger run <plan.yaml>`.

## License

TBD.
