import { Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"

import {
  type RunConfig,
  type ThinkingLevel,
  makeRunConfig
} from "../domain/config"

const version = "0.1.0"

const thinkingChoices = ["low", "medium", "high"] as const satisfies ReadonlyArray<ThinkingLevel>

export const makeDoCommand = <E, R>(runDo: (config: RunConfig) => Effect.Effect<void, E, R>) =>
  Command.make(
    "do",
    {
      planPath: Argument.string("plan"),
      harness: Flag.choice("harness", ["cursor"]).pipe(Flag.withDefault("cursor")),
      model: Flag.optional(Flag.string("model")),
      thinking: Flag.optional(Flag.choice("thinking", thinkingChoices)),
      maxConcurrency: Flag.optional(Flag.integer("max-concurrency")),
      dryRun: Flag.boolean("dry-run")
    },
    ({ dryRun, harness, maxConcurrency, model, planPath, thinking }) =>
      makeRunConfig({
        planPath,
        harness,
        model,
        thinking,
        maxConcurrency,
        dryRun,
        cwd: process.cwd()
      }).pipe(Effect.flatMap(runDo))
  ).pipe(Command.withDescription("Execute a markdown task graph"))

export const makeCli = <E, R>(runDo: (config: RunConfig) => Effect.Effect<void, E, R>) =>
  Command.make("dagger").pipe(
    Command.withDescription("Task-graph coding orchestrator"),
    Command.withSubcommands([makeDoCommand(runDo)])
  )

export const makeProgram = <E, R>(runDo: (config: RunConfig) => Effect.Effect<void, E, R>) =>
  Command.run(makeCli(runDo), { version })
