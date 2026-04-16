import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"

import { runDo } from "./app/run-do"
import { makeProgram } from "./cli/do"

const main = makeProgram(runDo).pipe(Effect.provide(BunServices.layer)) as Effect.Effect<
  void,
  unknown,
  never
>

BunRuntime.runMain(main)
