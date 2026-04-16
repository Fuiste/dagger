import { readFile } from "node:fs/promises"

import { Console, Effect, Schema } from "effect"

import { type RunConfig } from "../domain/config"
import { computeExecutionLevels, type TaskGraph } from "../domain/task-graph"
import { makeCursorHarness } from "../harness/cursor"
import { Harness, type HarnessShape } from "../harness/harness"
import { finalizeRun } from "../runtime/finalize-run"
import { runScheduler } from "../runtime/scheduler"
import { parseMarkdownGraph } from "../parse/markdown-graph"
import { makeStateService } from "../state/state-service"

export class DoCommandError extends Schema.TaggedErrorClass<DoCommandError>()("DoCommandError", {
  message: Schema.String
}) {}

const readPlanMarkdown = (planPath: string) =>
  Effect.tryPromise({
    try: () => readFile(planPath, "utf8"),
    catch: (error) =>
      new DoCommandError({
        message: error instanceof Error ? error.message : `Unable to read ${planPath}`
      })
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

const defaultHarnessForConfig = (runConfig: RunConfig): HarnessShape => {
  switch (runConfig.harness) {
    case "cursor":
      return makeCursorHarness()
  }
}

const executeGraph = (runConfig: RunConfig, graph: TaskGraph) =>
  Effect.scoped(
    Effect.gen(function*() {
      const harness = yield* Harness
      const stateService = yield* makeStateService({
        graph,
        runId: crypto.randomUUID()
      })
      const runState = yield* runScheduler({
        graph,
        stateService,
        ...(runConfig.maxConcurrency === undefined
          ? {}
          : { maxConcurrency: runConfig.maxConcurrency }),
        executeTask: (task) =>
          harness.executeTask({
            runConfig,
            task,
            statePath: stateService.path,
            cwd: runConfig.cwd
          })
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
  )

export const runDo = (runConfig: RunConfig) =>
  readPlanMarkdown(runConfig.planPath).pipe(
    Effect.flatMap(parseMarkdownGraph),
    Effect.flatMap((graph) =>
      runConfig.dryRun
        ? computeExecutionLevels(graph).pipe(
            Effect.mapError(
              (error) =>
                new DoCommandError({
                  message: error.message
                })
            ),
            Effect.flatMap((levels) => Console.log(renderDryRun(runConfig.planPath, graph, levels)))
          )
        : executeGraph(runConfig, graph)
    ),
    Effect.provideService(Harness, defaultHarnessForConfig(runConfig))
  )
