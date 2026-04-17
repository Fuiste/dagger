import { Effect, FileSystem, Schema } from "effect"

import { type RunConfig } from "../domain/config"
import { HarnessRegistry } from "../harness/harness"
import { type StateService } from "../state/state-service"
import { type RunState } from "../state/run-state"

export class FinalizeRunError extends Schema.TaggedErrorClass<FinalizeRunError>()("FinalizeRunError", {
  message: Schema.String
}) {}

const deleteStateFile = (path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem

    yield* fs.remove(path, { force: true }).pipe(
      Effect.mapError((error) =>
        new FinalizeRunError({
          message: error.message.length > 0 ? error.message : `Unable to delete ${path}`
        })
      )
    )
  })

export const finalizeRun = (options: {
  readonly runConfig: RunConfig
  readonly stateService: StateService
  readonly runState: RunState
}) =>
  Effect.gen(function*() {
    const harnessRegistry = yield* HarnessRegistry
    const harness = harnessRegistry.get(options.runConfig.harness)

    yield* options.stateService.flush

    return yield* harness.summarizeRun({
      runConfig: options.runConfig,
      statePath: options.stateService.path,
      runState: options.runState
    }).pipe(
      Effect.ensuring(deleteStateFile(options.stateService.path).pipe(Effect.catch(() => Effect.void)))
    )
  })
