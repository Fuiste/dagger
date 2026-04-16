import { Effect, Schema } from "effect"

import { type RunConfig } from "../domain/config"
import { type TaskDefinition } from "../domain/task-graph"
import { type RunState } from "../state/run-state"

export class HarnessError extends Schema.TaggedErrorClass<HarnessError>()("HarnessError", {
  message: Schema.String
}) {}

export type TaskHarnessInput = {
  readonly runConfig: RunConfig
  readonly task: TaskDefinition
  readonly statePath: string
  readonly cwd: string
}

export type SummaryHarnessInput = {
  readonly runConfig: RunConfig
  readonly runState: RunState
  readonly statePath: string
  readonly cwd: string
}

export type HarnessTaskResult = {
  readonly note?: string
  readonly summary?: string
}

export type Harness = {
  readonly executeTask: (input: TaskHarnessInput) => Effect.Effect<HarnessTaskResult, HarnessError>
  readonly summarizeRun: (input: SummaryHarnessInput) => Effect.Effect<string, HarnessError>
}
