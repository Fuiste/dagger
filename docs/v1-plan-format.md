# Dagger v1 Plan Format

`dagger run` consumes a supplied YAML DAG plan. Dagger does not synthesize the plan for you; its job is to execute the graph quickly, route model tasks to the right provider/model, and preserve structured artifacts and observability.

## Shape

```yaml
version: 1
defaults:
  cwd: .
  profile: balanced
  artifactsDir: .dagger/runs
  provider: auto
tasks:
  - id: design-direction
    kind: model
    role: designer
    dependsOn: [extract-constraints]
    prompt: Produce an implementation-oriented redesign direction.
    inputs:
      files:
        - app/routes/transformations.tsx
      artifacts:
        - taskId: extract-constraints
          artifactId: constraints
    outputs:
      - id: design_spec
        path: .dagger/generated/design-spec.json
        format: json
```

## Task Kinds

- `model`: delegate a separable slice to Codex or Cursor via role-based routing. Required fields: `role`, `prompt`, `outputs`.
- `command`: run a local shell command. Use for tests, targeted checks, or deterministic validation.
- `reduce`: merge upstream structured artifacts locally. Supported operations: `json-merge`, `json-array`, `text-concat`.
- `assert`: enforce artifact presence, run acceptance commands, and optionally constrain changed files.

## Roles

Runtime profiles map roles to actual models:

- `designer`
- `frontend_implementer`
- `backend_implementer`
- `reviewer`
- `cheap_reader`

Balanced defaults:

- `designer` -> Cursor `claude-opus-4-7-thinking-high`
- `frontend_implementer` -> Codex `gpt-5.4`
- `backend_implementer` -> Codex `gpt-5.4`
- `reviewer` -> Codex `gpt-5.4`
- `cheap_reader` -> Cursor `composer-2`

Override per task only when the plan author explicitly wants tighter coupling to a specific provider/model.

## Artifact Contracts

- Every `model` and `reduce` task must declare outputs.
- Paths are resolved relative to the run working directory.
- JSON outputs must be valid JSON files.
- Upstream tasks communicate through declared artifact files, not through a shared mutable run summary.

## CLI

```sh
dagger run path/to/plan.yaml \
  --profile balanced \
  --max-concurrency 3 \
  --events pretty
```

Useful flags:

- `--dry-run`: parse the plan, compute execution levels, and print routed model tasks.
- `--resume`: reuse the last unfinished run for the same plan digest.
- `--artifacts-dir PATH`: relocate run logs, projections, transcripts, and cache metadata.

## Examples

- [examples/site-redesign.plan.yaml](../examples/site-redesign.plan.yaml)
- [examples/structured-audit.plan.yaml](../examples/structured-audit.plan.yaml)
