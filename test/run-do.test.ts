import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { BunFileSystem } from "@effect/platform-bun"
import { Cause, Effect, Exit, Option, Ref } from "effect"

import { DoCommandError, runDo } from "../src/app/run-do"
import { makeRunConfig } from "../src/domain/config"
import {
  HarnessError,
  HarnessRegistry,
  makeHarnessRegistry,
  type HarnessShape
} from "../src/harness/harness"

const planMarkdown = `
## Tasks

### scaffold
- prompt: Set up the repository.

### parser
- prompt: Write the parser.

### runtime
- prompt: Build the runtime.

## Dependencies

- scaffold -> parser
- scaffold -> runtime
`

const mixedHarnessPlanMarkdown = `
## Tasks

### default-task
- prompt: Use the default harness settings.

### codex-task
- prompt: Use the codex override.
- harness: codex
- model: gpt-5.4
- thinking: high

## Dependencies
`

const makeTempPlan = async (markdown: string) => {
  const workspace = await mkdtemp(join(tmpdir(), "dagger-rundo-"))
  const planPath = join(workspace, "plan.md")

  await writeFile(planPath, markdown)

  return { workspace, planPath }
}

describe("runDo", () => {
  test("executes the graph end to end, records state events, and deletes the state file", async () => {
    const { workspace, planPath } = await makeTempPlan(planMarkdown)
    const runConfig = await Effect.runPromise(
      makeRunConfig({
        planPath,
        harness: "cursor",
        model: Option.none(),
        thinking: Option.none(),
        maxConcurrency: Option.none(),
        dryRun: false,
        cwd: workspace
      })
    )

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const taskCalls = yield* Ref.make<Array<string>>([])
        const capturedStatePath = yield* Ref.make<string | undefined>(undefined)
        const harness: HarnessShape = {
          executeTask: (input) =>
            Effect.gen(function*() {
              yield* Ref.update(taskCalls, (values) => [...values, input.task.id])
              yield* Ref.set(capturedStatePath, input.statePath)

              return { summary: `${input.task.id} done` }
            }),
          summarizeRun: (input) =>
            Effect.succeed(`Summarized ${input.runState.tasks.length} tasks`)
        }

        yield* runDo(runConfig).pipe(
          Effect.provideService(
            HarnessRegistry,
            makeHarnessRegistry({
              cursor: harness,
              codex: harness
            })
          )
        )

        return {
          taskCalls: yield* Ref.get(taskCalls),
          statePath: yield* Ref.get(capturedStatePath)
        }
      }).pipe(Effect.provide(BunFileSystem.layer))
    )

    expect(result.taskCalls.length).toBe(3)
    expect(result.taskCalls).toContain("scaffold")
    expect(result.taskCalls).toContain("parser")
    expect(result.taskCalls).toContain("runtime")
    expect(result.statePath).toBeDefined()
    if (result.statePath !== undefined) {
      expect(result.statePath.startsWith(workspace)).toBe(true)
      const exists = await Bun.file(result.statePath).exists()
      expect(exists).toBe(false)
    }
  })

  test("fails with DoCommandError when a task fails", async () => {
    const { workspace, planPath } = await makeTempPlan(planMarkdown)
    const runConfig = await Effect.runPromise(
      makeRunConfig({
        planPath,
        harness: "cursor",
        model: Option.none(),
        thinking: Option.none(),
        maxConcurrency: Option.none(),
        dryRun: false,
        cwd: workspace
      })
    )

    const harness: HarnessShape = {
      executeTask: (input) =>
        input.task.id === "scaffold"
          ? Effect.fail(new HarnessError({ message: "scaffold blew up" }))
          : Effect.succeed({}),
      summarizeRun: () => Effect.succeed("summary")
    }

    const exit = await Effect.runPromiseExit(
      runDo(runConfig).pipe(
        Effect.provideService(
          HarnessRegistry,
          makeHarnessRegistry({
            cursor: harness,
            codex: harness
          })
        ),
        Effect.provide(BunFileSystem.layer)
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(DoCommandError)
    }
  })

  test("prints the execution plan and skips execution in dry-run mode", async () => {
    const { workspace, planPath } = await makeTempPlan(planMarkdown)
    const runConfig = await Effect.runPromise(
      makeRunConfig({
        planPath,
        harness: "cursor",
        model: Option.none(),
        thinking: Option.none(),
        maxConcurrency: Option.none(),
        dryRun: true,
        cwd: workspace
      })
    )

    const harness: HarnessShape = {
      executeTask: () =>
        Effect.fail(new HarnessError({ message: "should not be called in dry-run" })),
      summarizeRun: () => Effect.succeed("unused")
    }

    const exit = await Effect.runPromiseExit(
      runDo(runConfig).pipe(
        Effect.provideService(
          HarnessRegistry,
          makeHarnessRegistry({
            cursor: harness,
            codex: harness
          })
        ),
        Effect.provide(BunFileSystem.layer)
      )
    )

    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("routes each task through its effective harness config and keeps summary on the CLI harness", async () => {
    const { workspace, planPath } = await makeTempPlan(mixedHarnessPlanMarkdown)
    const runConfig = await Effect.runPromise(
      makeRunConfig({
        planPath,
        harness: "cursor",
        model: Option.some("composer-2"),
        thinking: Option.some("medium"),
        maxConcurrency: Option.some(1),
        dryRun: false,
        cwd: workspace
      })
    )

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const taskCalls = yield* Ref.make<
          Array<{
            readonly harness: string
            readonly taskId: string
            readonly model: string | undefined
            readonly thinking: string | undefined
          }>
        >([])
        const summaryCalls = yield* Ref.make<Array<string>>([])

        const cursorHarness: HarnessShape = {
          executeTask: (input) =>
            Effect.gen(function*() {
              yield* Ref.update(taskCalls, (values) => [
                ...values,
                {
                  harness: "cursor",
                  taskId: input.task.id,
                  model: input.taskRunConfig.model,
                  thinking: input.taskRunConfig.thinking
                }
              ])

              return { summary: `${input.task.id} via cursor` }
            }),
          summarizeRun: () =>
            Effect.gen(function*() {
              yield* Ref.update(summaryCalls, (values) => [...values, "cursor"])

              return "cursor summary"
            })
        }
        const codexHarness: HarnessShape = {
          executeTask: (input) =>
            Effect.gen(function*() {
              yield* Ref.update(taskCalls, (values) => [
                ...values,
                {
                  harness: "codex",
                  taskId: input.task.id,
                  model: input.taskRunConfig.model,
                  thinking: input.taskRunConfig.thinking
                }
              ])

              return { summary: `${input.task.id} via codex` }
            }),
          summarizeRun: () =>
            Effect.gen(function*() {
              yield* Ref.update(summaryCalls, (values) => [...values, "codex"])

              return "codex summary"
            })
        }

        yield* runDo(runConfig).pipe(
          Effect.provideService(
            HarnessRegistry,
            makeHarnessRegistry({
              cursor: cursorHarness,
              codex: codexHarness
            })
          )
        )

        return {
          taskCalls: yield* Ref.get(taskCalls),
          summaryCalls: yield* Ref.get(summaryCalls)
        }
      }).pipe(Effect.provide(BunFileSystem.layer))
    )

    expect(result.taskCalls).toEqual([
      {
        harness: "cursor",
        taskId: "default-task",
        model: "composer-2",
        thinking: "medium"
      },
      {
        harness: "codex",
        taskId: "codex-task",
        model: "gpt-5.4",
        thinking: "high"
      }
    ])
    expect(result.summaryCalls).toEqual(["cursor"])
  })
})
