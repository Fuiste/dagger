import { Effect, Schema } from "effect"

import { type RunConfig } from "../domain/config"
import { TaskDefinition } from "../domain/task-graph"
import { type RunState } from "../state/run-state"

export class HarnessError extends Schema.TaggedErrorClass<HarnessError>()("HarnessError", {
  message: Schema.String
}) {}

export class HarnessTaskInput extends Schema.Class<HarnessTaskInput>("HarnessTaskInput")({
  runConfig: Schema.Unknown,
  task: TaskDefinition,
  statePath: Schema.String,
  cwd: Schema.String
}) {}

export class HarnessSummaryInput extends Schema.Class<HarnessSummaryInput>("HarnessSummaryInput")({
  runConfig: Schema.Unknown,
  statePath: Schema.String,
  cwd: Schema.String,
  runState: Schema.Unknown
}) {}

export type TaskHarnessInput = Omit<HarnessTaskInput, "runConfig"> & {
  readonly runConfig: RunConfig
}

export type SummaryHarnessInput = Omit<HarnessSummaryInput, "runState" | "runConfig"> & {
  readonly runConfig: RunConfig
  readonly runState: RunState
}

export type HarnessTaskResult = {
  readonly note?: string
  readonly summary?: string
}

export type Harness = {
  readonly executeTask: (input: TaskHarnessInput) => Effect.Effect<HarnessTaskResult, HarnessError>
  readonly summarizeRun: (input: SummaryHarnessInput) => Effect.Effect<string, HarnessError>
}
