import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { Duration, Effect } from "effect"

import { parseMarkdownGraph } from "../src/parse/markdown-graph"
import { runScheduler } from "../src/runtime/scheduler"
import { makeStateService } from "../src/state/state-service"

const parallelGraphMarkdown = `
## Tasks

### a
- prompt: Task a.

### b
- prompt: Task b.

### c
- prompt: Task c.

## Dependencies

- a -> c
- b -> c
`

const failureGraphMarkdown = `
## Tasks

### a
- prompt: Task a.

### b
- prompt: Task b.

### c
- prompt: Task c.

### d
- prompt: Task d.

## Dependencies

- a -> c
- c -> d
`

const concurrentFailureGraphMarkdown = `
## Tasks

### lead1
- prompt: Leader 1.

### lead2
- prompt: Leader 2.

### lead3
- prompt: Leader 3.

### lead4
- prompt: Leader 4.

### follow1
- prompt: Follower 1.

### follow2
- prompt: Follower 2.

### follow3
- prompt: Follower 3.

### follow4
- prompt: Follower 4.

## Dependencies

- lead1 -> follow1
- lead2 -> follow1
- lead1 -> follow2
- lead3 -> follow2
- lead2 -> follow3
- lead4 -> follow3
- lead3 -> follow4
- lead4 -> follow4
`

const terminalTags = new Set(["TaskSucceededEvent", "TaskFailedEvent", "TaskSkippedEvent"])

describe("runScheduler", () => {
  test("launches newly unblocked children after all dependencies succeed", async () => {
    const graph = await Effect.runPromise(parseMarkdownGraph(parallelGraphMarkdown))
    const stateRootDir = await mkdtemp(join(tmpdir(), "dagger-scheduler-"))
    const starts: Array<string> = []

    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const stateService = yield* makeStateService({
            graph,
            runId: "scheduler-success",
            stateRootDir
          })

          return yield* runScheduler({
            graph,
            stateService,
            maxConcurrency: 2,
            executeTask: (task) =>
              Effect.gen(function*() {
                yield* Effect.sync(() => {
                  starts.push(task.id)
                })
                yield* Effect.sleep(Duration.millis(10))

                return {
                  summary: `${task.id} done`
                }
              })
          })
        })
      )
    )

    expect(starts.slice(0, 2).sort()).toEqual(["a", "b"])
    expect(starts.at(-1)).toBe("c")
    expect(state.tasks.map((task) => [task.id, task.status])).toEqual([
      ["a", "succeeded"],
      ["b", "succeeded"],
      ["c", "succeeded"]
    ])
  })

  test("marks blocked descendants as skipped after a failure", async () => {
    const graph = await Effect.runPromise(parseMarkdownGraph(failureGraphMarkdown))
    const stateRootDir = await mkdtemp(join(tmpdir(), "dagger-scheduler-"))

    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const stateService = yield* makeStateService({
            graph,
            runId: "scheduler-failure",
            stateRootDir
          })

          return yield* runScheduler({
            graph,
            stateService,
            maxConcurrency: 2,
            executeTask: (task) =>
              task.id === "a"
                ? Effect.sleep(Duration.millis(10)).pipe(
                    Effect.andThen(Effect.fail(new Error("task a failed")))
                  )
                : Effect.sleep(Duration.millis(5)).pipe(
                    Effect.as({
                      summary: `${task.id} done`
                    })
                  )
          })
        })
      )
    )

    expect(state.status).toBe("failed")
    expect(state.tasks.map((task) => [task.id, task.status])).toEqual([
      ["a", "failed"],
      ["b", "succeeded"],
      ["c", "skipped"],
      ["d", "skipped"]
    ])
  })

  test("emits exactly one terminal event per task when leaders fail concurrently", async () => {
    const graph = await Effect.runPromise(parseMarkdownGraph(concurrentFailureGraphMarkdown))
    const stateRootDir = await mkdtemp(join(tmpdir(), "dagger-scheduler-"))

    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const stateService = yield* makeStateService({
            graph,
            runId: "scheduler-terminal-invariant",
            stateRootDir
          })

          return yield* runScheduler({
            graph,
            stateService,
            maxConcurrency: 4,
            executeTask: (task) =>
              task.id === "lead1" || task.id === "lead3"
                ? Effect.yieldNow.pipe(
                    Effect.andThen(Effect.fail(new Error(`${task.id} failed`)))
                  )
                : Effect.yieldNow.pipe(
                    Effect.as({ summary: `${task.id} done` })
                  )
          })
        })
      )
    )

    const terminalEventsByTask = state.events.reduce(
      (counts, event) =>
        terminalTags.has(event._tag)
          ? counts.set(event.taskId, (counts.get(event.taskId) ?? 0) + 1)
          : counts,
      new Map<string, number>()
    )

    expect(state.tasks.length).toBe(8)
    for (const task of state.tasks) {
      expect([task.id, terminalEventsByTask.get(task.id) ?? 0]).toEqual([task.id, 1])
    }
    expect(state.status).toBe("failed")
  })
})
