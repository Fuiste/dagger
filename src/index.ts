import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"

import { defaultHarnessRegistry, runDo } from "./app/run-do"
import { makeProgram } from "./cli/do"
import { HarnessRegistry } from "./harness/harness"

const main = makeProgram((runConfig) =>
  runDo(runConfig).pipe(
    Effect.provideService(HarnessRegistry, defaultHarnessRegistry())
  )
).pipe(Effect.provide(BunServices.layer))

BunRuntime.runMain(main)
