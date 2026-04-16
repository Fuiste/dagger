import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"

import { defaultHarnessForConfig, runDo } from "./app/run-do"
import { makeProgram } from "./cli/do"
import { Harness } from "./harness/harness"

const main = makeProgram((runConfig) =>
  runDo(runConfig).pipe(
    Effect.provideService(Harness, defaultHarnessForConfig(runConfig))
  )
).pipe(Effect.provide(BunServices.layer))

BunRuntime.runMain(main)
