import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"

import { makeProgram } from "./v1/cli"

const main = makeProgram().pipe(Effect.provide(BunServices.layer))

BunRuntime.runMain(main)
