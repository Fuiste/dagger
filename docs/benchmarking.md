# Benchmarking Dagger

This repo includes an internal benchmark harness for comparing direct Codex/Cursor runs against Dagger-orchestrated runs on real repos.

## Scope

- `optics` code/report tasks
- `contact-sheet-api` frontend and full-stack tasks
- five benchmark arms:
  - `direct-codex`
  - `direct-cursor`
  - `dagger-codex`
  - `dagger-mixed`
  - `dagger-cheap-swarm`

## Commands

```sh
bun run benchmark:tasks
bun run benchmark:preflight
bun run benchmark:run
bun run benchmark:report
```

Useful filters:

```sh
bun run benchmark:run -- --tasks optics-compose-audit --arms dagger-mixed --context-pack deterministic --repetitions 1
```

## Output Layout

Benchmark artifacts are written to `benchmark-results/` and ignored by git.

Each campaign writes:

- `campaign.json` with the queued run matrix
- `summary.json` and `summary.md`
- `runs/<task>-<arm>-rN/`

Each run directory captures:

- prompts
- generated Dagger plan when applicable
- stdout/stderr for planning, execution, and acceptance commands
- diff stat and diff patch
- telemetry captured from the Dagger harness wrappers
- a blind review packet for later second-pass evaluation

## Preflight

Preflight runs before timed campaigns unless `--skip-preflight` is set.

It performs the explicit setup and model checks from the benchmark plan:

- `bun install` in this repo
- local `dagger do --help` verification
- smoke checks for:
  - `gpt-5.4`
  - `claude-opus-4-7-high`
  - `claude-opus-4-7-thinking-high`
  - `composer-2`

## Dagger Telemetry Wrappers

The benchmark runner points `DAGGER_CODEX_COMMAND` and `DAGGER_CURSOR_COMMAND` at local wrapper scripts in `bin/`.

Those wrappers:

- preserve the underlying CLI behavior
- capture duration, args, cwd, stdout, and stderr
- write per-invocation JSON records into the run's telemetry directory

For Codex-backed Dagger nodes the runner also sets `DAGGER_CODEX_EXTRA_ARGS=--json`, which makes usage payloads easier to recover from stdout without affecting the final assistant-message file that the Codex harness reads.

## Blind Review

The runner creates `blind-review.md` for each completed run. That packet is designed for a second-pass reviewer who should not know which arm produced the output.

Review scores are not auto-generated yet; the packet is the stable handoff artifact so a reviewer can score correctness, repo fit, completeness, churn, and the UI-specific dimensions where relevant.
