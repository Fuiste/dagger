import { Console, Effect, FileSystem, Schema } from "effect"

import { type RunConfig } from "../domain/config"
import { computeExecutionLevels, type TaskGraph } from "../domain/task-graph"
import { makeCursorHarness } from "../harness/cursor"
import {
  HarnessRegistry,
  type HarnessRegistryShape,
  makeHarnessRegistry,
  resolveTaskRunConfig
} from "../harness/harness"
import { finalizeRun } from "../runtime/finalize-run"
import { runScheduler } from "../runtime/scheduler"
import { parseMarkdownGraph } from "../parse/markdown-graph"
import { makeStateService } from "../state/state-service"

export class DoCommandError extends Schema.TaggedErrorClass<DoCommandError>()("DoCommandError", {
  message: Schema.String
}) {}

const toDoCommandError = (error: { readonly message: string }) =>
  new DoCommandError({ message: error.message })

const readPlanMarkdown = (planPath: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem

    return yield* fs.readFileString(planPath).pipe(
      Effect.mapError((error) =>
        new DoCommandError({
          message: error.message.length > 0 ? error.message : `Unable to read ${planPath}`
        })
      )
    )
  })

export const renderDryRun = (
  planPath: string,
  graph: TaskGraph,
  levels: ReadonlyArray<ReadonlyArray<string>>
) =>
  [
    `Dry run for ${planPath}`,
    `Tasks: ${graph.tasks.length}`,
    ...levels.map((level, index) => `Level ${index + 1}: ${level.join(", ")}`)
  ].join("\n")

export const defaultHarnessRegistry = (): HarnessRegistryShape =>
  makeHarnessRegistry({
    cursor: makeCursorHarness()
  })

const executeGraph = (runConfig: RunConfig, graph: TaskGraph) =>
  Effect.scoped(
    Effect.gen(function*() {
      const harnessRegistry = yield* HarnessRegistry
      const stateService = yield* makeStateService({
        graph,
        runId: crypto.randomUUID(),
        stateRootDir: `${runConfig.cwd}/.dagger/runs`
      })
      const runState = yield* runScheduler({
        graph,
        stateService,
        ...(runConfig.maxConcurrency === undefined
          ? {}
          : { maxConcurrency: runConfig.maxConcurrency }),
        executeTask: (task) => {
          const taskRunConfig = resolveTaskRunConfig(runConfig, task)
          const harness = harnessRegistry.get(taskRunConfig.harness)

          return harness.executeTask({
            taskRunConfig,
            task,
            statePath: stateService.path
          })
        }
      })
      const summary = yield* finalizeRun({
        runConfig,
        stateService,
        runState
      })

      yield* Console.log(summary)

      if (runState.status === "failed") {
        return yield* new DoCommandError({
          message: "One or more tasks failed during execution"
        })
      }
    })
  ).pipe(Effect.mapError(toDoCommandError))

export const runDo = (runConfig: RunConfig) =>
  readPlanMarkdown(runConfig.planPath).pipe(
    Effect.flatMap((source) => parseMarkdownGraph(source).pipe(Effect.mapError(toDoCommandError))),
    Effect.flatMap((graph) =>
      runConfig.dryRun
        ? computeExecutionLevels(graph).pipe(
            Effect.mapError(toDoCommandError),
            Effect.flatMap((levels) => Console.log(renderDryRun(runConfig.planPath, graph, levels)))
          )
        : executeGraph(runConfig, graph)
    )
  )
