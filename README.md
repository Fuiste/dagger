# dagger

> **Status:** work in progress. APIs, flags, and file formats are unstable and will change without notice.

`dagger` is a CLI that builds software from a task graph described in markdown. Each node in the graph is handed to a pluggable coding harness, and the graph is executed maximally in parallel — a task fires the moment all of its parents succeed. A final harness call summarizes the run from an ephemeral state document, which is then deleted.

The project is written in [Bun](https://bun.sh) with [Effect v4](https://github.com/Effect-TS/effect-smol) (beta), and leans on structured concurrency, typed errors, and the platform `FileSystem` service rather than ad-hoc I/O.

## Quick start

```sh
bun install
bun test
bun run src/index.ts do path/to/plan.md --harness cursor --dry-run
```

A real run looks like:

```sh
bun run src/index.ts do plan.md \
  --harness codex \
  --model gpt-5-codex \
  --max-concurrency 3
```

`--harness` is the required run default and also the harness used for the final run summary. Individual tasks may still override `harness`, `model`, and `thinking` in the markdown graph; task metadata takes precedence over the CLI defaults.

See [`docs/task-graph-format.md`](docs/task-graph-format.md) for the markdown syntax and an example plan.

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
- No npm distribution yet — run it from source with Bun.
- Cursor Agent CLI itself may need `NODE_EXTRA_CA_CERTS` set in environments with a corporate TLS proxy; streaming sessions can still be blocked by SSL inspection of long-lived HTTP/2 connections.
- Codex runs are ephemeral by default and currently rely on the local `codex` CLI being installed and authenticated.

## License

TBD.
