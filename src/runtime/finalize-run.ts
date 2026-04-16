import { rm } from "node:fs/promises"

import { Effect, Schema } from "effect"

import { type RunConfig } from "../domain/config"
import { Harness } from "../harness/harness"
import { type StateService } from "../state/state-service"
import { type RunState } from "../state/run-state"

export class FinalizeRunError extends Schema.TaggedErrorClass<FinalizeRunError>()("FinalizeRunError", {
  message: Schema.String
}) {}

const deleteStateFile = (path: string) =>
  Effect.tryPromise({
    try: () => rm(path, { force: true }),
    catch: (error) =>
      new FinalizeRunError({
        message: error instanceof Error ? error.message : `Unable to delete ${path}`
      })
  })

export const finalizeRun = (options: {
  readonly runConfig: RunConfig
  readonly stateService: StateService
  readonly runState: RunState
}) =>
  Effect.gen(function*() {
    const harness = yield* Harness

    yield* options.stateService.flush

    return yield* harness.summarizeRun({
      runConfig: options.runConfig,
      statePath: options.stateService.path,
      cwd: options.runConfig.cwd,
      runState: options.runState
    }).pipe(
      Effect.ensuring(deleteStateFile(options.stateService.path).pipe(Effect.catch(() => Effect.void)))
    )
  })
