import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { BunFileSystem } from "@effect/platform-bun"
import { Cause, Effect, Exit, Ref } from "effect"

import { parseMarkdownGraph } from "../src/parse/markdown-graph"
import { StateServiceError, makeStateService } from "../src/state/state-service"
import {
  TaskQueuedEvent,
  TaskStartedEvent,
  TaskSucceededEvent
} from "../src/state/run-state"

const simpleGraphMarkdown = `
## Tasks

### scaffold
- prompt: Set up the repository.

## Dependencies
`

describe("makeStateService", () => {
  test("folds events into the in-memory snapshot and persisted json", async () => {
    const graph = await Effect.runPromise(parseMarkdownGraph(simpleGraphMarkdown))
    const stateRootDir = await mkdtemp(join(tmpdir(), "dagger-state-"))

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const stateService = yield* makeStateService({
            graph,
            runId: "run-state-test",
            stateRootDir
          })

          yield* stateService.append(
            new TaskQueuedEvent({
              taskId: "scaffold",
              timestamp: "2026-04-16T00:00:00.000Z"
            })
          )
          yield* stateService.append(
            new TaskStartedEvent({
              taskId: "scaffold",
              timestamp: "2026-04-16T00:00:01.000Z",
              note: "starting task"
            })
          )
          yield* stateService.append(
            new TaskSucceededEvent({
              taskId: "scaffold",
              timestamp: "2026-04-16T00:00:02.000Z",
              note: "finished task",
              summary: "done"
            })
          )
          yield* stateService.flush

          const snapshot = yield* stateService.snapshot
          const persisted = yield* Effect.promise(() => Bun.file(stateService.path).json())

          return {
            snapshot,
            persisted
          }
        })
      ).pipe(Effect.provide(BunFileSystem.layer))
    )

    expect(result.snapshot.status).toBe("succeeded")
    expect(result.snapshot.tasks[0]).toEqual({
      id: "scaffold",
      prompt: "Set up the repository.",
      status: "succeeded",
      notes: ["starting task", "finished task"],
      startedAt: "2026-04-16T00:00:01.000Z",
      finishedAt: "2026-04-16T00:00:02.000Z",
      result: "done"
    })
    expect(result.persisted.status).toBe("succeeded")
    expect(result.persisted.events).toHaveLength(3)
  })

  test("surfaces background writer failures on subsequent append and flush", async () => {
    const graph = await Effect.runPromise(parseMarkdownGraph(simpleGraphMarkdown))
    const stateRootDir = await mkdtemp(join(tmpdir(), "dagger-state-fail-"))

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function*() {
          const writeCount = yield* Ref.make(0)
          const stateService = yield* makeStateService({
            graph,
            runId: "writer-error",
            stateRootDir,
            writeRunState: () =>
              Effect.gen(function*() {
                const count = yield* Ref.updateAndGet(writeCount, (value) => value + 1)

                if (count > 1) {
                  return yield* Effect.fail(new StateServiceError({ message: "disk full" }))
                }
              })
          })

          yield* stateService.append(
            new TaskQueuedEvent({
              taskId: "scaffold",
              timestamp: "2026-04-16T00:00:00.000Z"
            })
          )
          yield* stateService.flush
        })
      ).pipe(Effect.provide(BunFileSystem.layer))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(StateServiceError)
      expect((error as StateServiceError).message).toBe("disk full")
    }
  })
})
