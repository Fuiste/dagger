import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"

import { makeProgram } from "./cli/do"

const main = makeProgram(() =>
  Effect.log("dagger runtime is not implemented yet")
).pipe(Effect.provide(BunServices.layer))

BunRuntime.runMain(main)
