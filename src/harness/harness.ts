import { Context, Effect, Schema } from "effect"

import { type HarnessName, type RunConfig, type ThinkingLevel } from "../domain/config"
import { type TaskDefinition } from "../domain/task-graph"
import { type RunState } from "../state/run-state"

export class HarnessError extends Schema.TaggedErrorClass<HarnessError>()("HarnessError", {
  message: Schema.String
}) {}

export type EffectiveTaskConfig = {
  readonly harness: HarnessName
  readonly model?: string
  readonly thinking?: ThinkingLevel
  readonly cwd: string
}

export type TaskHarnessInput = {
  readonly taskRunConfig: EffectiveTaskConfig
  readonly task: TaskDefinition
  readonly statePath: string
}

export type SummaryHarnessInput = {
  readonly runConfig: RunConfig
  readonly runState: RunState
  readonly statePath: string
}

export type HarnessTaskResult = {
  readonly note?: string
  readonly summary?: string
}

export type HarnessShape = {
  readonly executeTask: (input: TaskHarnessInput) => Effect.Effect<HarnessTaskResult, HarnessError>
  readonly summarizeRun: (input: SummaryHarnessInput) => Effect.Effect<string, HarnessError>
}

export type HarnessRegistryShape = {
  readonly get: (name: HarnessName) => HarnessShape
}

export class HarnessRegistry extends Context.Service<HarnessRegistry, HarnessRegistryShape>()(
  "dagger/HarnessRegistry"
) {}

export const makeHarnessRegistry = (registry: Readonly<Record<HarnessName, HarnessShape>>) => ({
  get: (name: HarnessName) => registry[name]
})

export const resolveTaskRunConfig = (
  runConfig: RunConfig,
  task: TaskDefinition
): EffectiveTaskConfig => ({
  harness: task.harness ?? runConfig.harness,
  ...(task.model === undefined
    ? runConfig.model === undefined
      ? {}
      : { model: runConfig.model }
    : { model: task.model }),
  ...(task.thinking === undefined
    ? runConfig.thinking === undefined
      ? {}
      : { thinking: runConfig.thinking }
    : { thinking: task.thinking }),
  cwd: runConfig.cwd
})
