import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { BunFileSystem } from "@effect/platform-bun"
import { Cause, Effect, Exit, Option, Ref } from "effect"

import { DoCommandError, runDo } from "../src/app/run-do"
import { makeRunConfig } from "../src/domain/config"
import { Harness, HarnessError, type HarnessShape } from "../src/harness/harness"

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

        yield* runDo(runConfig).pipe(Effect.provideService(Harness, harness))

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
        Effect.provideService(Harness, harness),
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
        Effect.provideService(Harness, harness),
        Effect.provide(BunFileSystem.layer)
      )
    )

    expect(Exit.isSuccess(exit)).toBe(true)
  })
})
