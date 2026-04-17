# dagger

> **Status:** work in progress. APIs, flags, and file formats are unstable and will change without notice.

`dagger` is a CLI that builds software from a task graph described in markdown. Each node in the graph is handed to a pluggable coding harness (defaulting to the Cursor Agent CLI) and the graph is executed maximally in parallel — a task fires the moment all of its parents succeed. A final harness call summarizes the run from an ephemeral state document, which is then deleted.

The project is written in [Bun](https://bun.sh) with [Effect v4](https://github.com/Effect-TS/effect-smol) (beta), and leans on structured concurrency, typed errors, and the platform `FileSystem` service rather than ad-hoc I/O.

## Quick start

```sh
bun install
bun test
bun run src/index.ts do path/to/plan.md --dry-run
```

A real run looks like:

```sh
bun run src/index.ts do plan.md \
  --harness cursor \
  --model composer-2 \
  --max-concurrency 3
```

See [`docs/task-graph-format.md`](docs/task-graph-format.md) for the markdown syntax and an example plan.

## Architecture sketch

- `src/cli` — Effect CLI entry points and flag parsing.
- `src/domain` — `RunConfig`, harness/thinking schemas.
- `src/parse` — markdown → `TaskGraph` parser with schema-validated metadata.
- `src/runtime` — DAG scheduler, run finalization, state persistence.
- `src/state` — ephemeral run state service (single-writer queue, surfaced writer errors).
- `src/harness` — `Harness` service interface + Cursor Agent adapter; structured `DAGGER_EVENT` stdout protocol.
- `test/` — unit and integration tests (scheduler, state service, parser, harness, end-to-end `runDo`).

## Known limitations

- Only the Cursor Agent harness is wired up today. Adding more harnesses means implementing the `Harness` service and registering it in `src/app/run-do.ts`.
- Worktree support is intentionally out of scope for this pass.
- No npm distribution yet — run it from source with Bun.
- Cursor Agent CLI itself may need `NODE_EXTRA_CA_CERTS` set in environments with a corporate TLS proxy; streaming sessions can still be blocked by SSL inspection of long-lived HTTP/2 connections.

## License

TBD.
