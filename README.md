# dagger

> **Status:** work in progress. APIs, flags, and file formats are unstable and will change without notice.

`dagger` is a CLI that builds software from a task graph described in markdown. Each node in the graph is handed to a pluggable coding harness, and the graph is executed maximally in parallel — a task fires the moment all of its parents succeed. A final harness call summarizes the run from an ephemeral state document, which is then deleted.

The project is written in [Bun](https://bun.sh) with [Effect v4](https://github.com/Effect-TS/effect-smol) (beta), and leans on structured concurrency, typed errors, and the platform `FileSystem` service rather than ad-hoc I/O.

## Quick start

```sh
bun install
bun test
bunx @fuiste/dagger do path/to/plan.md --harness cursor --dry-run
```

A real run looks like:

```sh
dagger do plan.md \
  --harness codex \
  --model gpt-5.4 \
  --max-concurrency 3
```

`--harness` is the required run default and also the harness used for the final run summary. Individual tasks may still override `harness`, `model`, and `thinking` in the markdown graph; task metadata takes precedence over the CLI defaults.

See [`docs/task-graph-format.md`](docs/task-graph-format.md) for the markdown syntax and an example plan.

## Install

`dagger` is published as [`@fuiste/dagger`](https://www.npmjs.com/package/@fuiste/dagger) and expects Bun at runtime.

Run it ad hoc with:

```sh
bunx @fuiste/dagger do plan.md --harness codex --dry-run
```

Or install it globally:

```sh
npm install -g @fuiste/dagger
dagger do plan.md --harness codex --dry-run
```

## Current fit

Live QA has been most encouraging for source-grounded tasks that benefit from explicit intermediate artifacts, for example:

- repo introspection or reporting tools built from multiple existing source files
- migration-readiness or compliance audits where partial analysis is useful on its own
- refactors where fact-extraction and implementation can be separated cleanly

Right now `dagger` looks more compelling as a control and observability tool than as a pure speed play. Its best runs make progress legible mid-flight through task-level artifacts and archived state, even when the overall run is slower than a single large prompt.

## Architecture sketch

- `src/cli` — Effect CLI entry points and flag parsing.
- `src/domain` — `RunConfig`, harness/thinking schemas.
- `src/parse` — markdown → `TaskGraph` parser with schema-validated metadata.
- `src/runtime` — DAG scheduler, run finalization, state persistence.
- `src/state` — ephemeral run state service (single-writer queue, surfaced writer errors).
- `src/harness` — harness registry, Cursor/Codex adapters, shared prompts/process helpers, and the `DAGGER_EVENT` assistant-message protocol.
- `test/` — unit and integration tests (scheduler, state service, parser, harness, end-to-end `runDo`).

## Known limitations

- Worktree support is intentionally out of scope for this pass.
- The published package still expects Bun to be installed locally; this is a Bun-backed CLI, not a Node-native standalone binary.
- Cursor Agent CLI itself may need `NODE_EXTRA_CA_CERTS` set in environments with a corporate TLS proxy; streaming sessions can still be blocked by SSL inspection of long-lived HTTP/2 connections.
- Codex runs are ephemeral by default and currently rely on the local `codex` CLI being installed and authenticated.
- End-to-end latency can still be significantly worse than a single-shot Codex run when the graph is tightly coupled or the final integration task does too much work.
- Some Codex-backed runs have reached full task success but then hung in finalization instead of returning cleanly. The produced artifacts can still be correct, but runner completion reliability needs hardening.
- Task decomposition does not yet make much weaker models a safe drop-in replacement for stronger ones on environment-discovery-heavy tasks; early analysis mistakes can still invalidate the whole graph.

## License

TBD.
