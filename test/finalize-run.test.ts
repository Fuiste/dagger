import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { BunFileSystem } from "@effect/platform-bun"
import { Effect, Option } from "effect"

import { renderDryRun } from "../src/app/run-do"
import { makeRunConfig } from "../src/domain/config"
import { computeExecutionLevels } from "../src/domain/task-graph"
import {
  HarnessError,
  HarnessRegistry,
  makeHarnessRegistry,
  type HarnessShape
} from "../src/harness/harness"
import { parseMarkdownGraph } from "../src/parse/markdown-graph"
import { finalizeRun } from "../src/runtime/finalize-run"
import { makeStateService } from "../src/state/state-service"

const graphMarkdown = `
## Tasks

### scaffold
- prompt: Set up the repository.

### parser
- prompt: Add the parser.

## Dependencies

- scaffold -> parser
`

describe("finalizeRun", () => {
  test("returns the harness summary and deletes the state file", async () => {
    const graph = await Effect.runPromise(parseMarkdownGraph(graphMarkdown))
    const runConfig = await Effect.runPromise(
      makeRunConfig({
        planPath: "plan.md",
        harness: "cursor",
        model: Option.none(),
        thinking: Option.none(),
        maxConcurrency: Option.none(),
        dryRun: false,
        cwd: "/workspace/dagger"
      })
    )
    const stateRootDir = await mkdtemp(join(tmpdir(), "dagger-finalize-"))
    const harness: HarnessShape = {
      executeTask: () => Effect.succeed({}),
      summarizeRun: (input) =>
        Effect.succeed(`summary for ${input.runState.tasks.length} tasks`)
    }

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const stateService = yield* makeStateService({
            graph,
            runId: "finalize-run",
            stateRootDir
          })
          const runState = yield* stateService.snapshot
          const summary = yield* finalizeRun({
            runConfig,
            stateService,
            runState
          }).pipe(
            Effect.provideService(
              HarnessRegistry,
              makeHarnessRegistry({
                cursor: harness,
                codex: harness
              })
            )
          )
          const exists = yield* Effect.promise(() => Bun.file(stateService.path).exists())

          return {
            summary,
            exists
          }
        })
      ).pipe(Effect.provide(BunFileSystem.layer))
    )

    expect(result).toEqual({
      summary: "summary for 2 tasks",
      exists: false
    })
  })

  test("still deletes the state file when summary generation fails", async () => {
    const graph = await Effect.runPromise(parseMarkdownGraph(graphMarkdown))
    const runConfig = await Effect.runPromise(
      makeRunConfig({
        planPath: "plan.md",
        harness: "cursor",
        model: Option.none(),
        thinking: Option.none(),
        maxConcurrency: Option.none(),
        dryRun: false,
        cwd: "/workspace/dagger"
      })
    )
    const stateRootDir = await mkdtemp(join(tmpdir(), "dagger-finalize-"))
    const harness: HarnessShape = {
      executeTask: () => Effect.succeed({}),
      summarizeRun: () =>
        Effect.fail(
          new HarnessError({
            message: "summary failed"
          })
        )
    }

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const stateService = yield* makeStateService({
            graph,
            runId: "finalize-run-error",
            stateRootDir
          })
          const runState = yield* stateService.snapshot
          const exit = yield* Effect.exit(
            finalizeRun({
              runConfig,
              stateService,
              runState
            }).pipe(
              Effect.provideService(
                HarnessRegistry,
                makeHarnessRegistry({
                  cursor: harness,
                  codex: harness
                })
              )
            )
          )
          const exists = yield* Effect.promise(() => Bun.file(stateService.path).exists())

          return {
            exit,
            exists
          }
        })
      ).pipe(Effect.provide(BunFileSystem.layer))
    )

    expect(result.exists).toBe(false)
    expect(result.exit._tag).toBe("Failure")
  })
})

describe("renderDryRun", () => {
  test("renders execution levels for the dry-run path", async () => {
    const graph = await Effect.runPromise(parseMarkdownGraph(graphMarkdown))
    const levels = await Effect.runPromise(computeExecutionLevels(graph))

    expect(renderDryRun("plan.md", graph, levels)).toEqual(
      ["Dry run for plan.md", "Tasks: 2", "Level 1: scaffold", "Level 2: parser"].join("\n")
    )
  })
})
