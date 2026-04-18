import { readFile } from "node:fs/promises"

import { Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"

import { executePlan, renderDryRunPreview } from "./engine"
import { type RuntimeProfile, resolvePlan } from "./plan"

const version = "1.0.0"
const profileChoices = ["fast", "balanced", "thorough", "cheap"] as const satisfies ReadonlyArray<RuntimeProfile>
const eventChoices = ["pretty", "json"] as const

const renderEvent = (mode: (typeof eventChoices)[number], event: unknown) =>
  mode === "json" ? JSON.stringify(event) : `[${(event as { readonly _tag: string })._tag}] ${JSON.stringify(event)}`

export const makeRunCommand = () =>
  Command.make(
    "run",
    {
      planPath: Argument.string("plan"),
      profile: Flag.optional(Flag.choice("profile", profileChoices)),
      maxConcurrency: Flag.optional(Flag.integer("max-concurrency")),
      artifactsDir: Flag.optional(Flag.string("artifacts-dir")),
      events: Flag.optional(Flag.choice("events", eventChoices)),
      resume: Flag.boolean("resume"),
      dryRun: Flag.boolean("dry-run")
    },
    ({ artifactsDir, dryRun, events, maxConcurrency, planPath, profile, resume }) =>
      Effect.promise(async () => {
        const source = await readFile(planPath, "utf8")
        const resolvedPlan = resolvePlan({
          planPath,
          source,
          cwd: process.cwd(),
          ...(profile._tag === "Some" ? { profile: profile.value } : {}),
          ...(artifactsDir._tag === "Some" ? { artifactsDir: artifactsDir.value } : {})
        })
        const eventMode = events._tag === "Some" ? events.value : "pretty"

        if (dryRun) {
          console.log(renderDryRunPreview(resolvedPlan))
          return
        }

        const handle = executePlan({
          resolvedPlan,
          ...(maxConcurrency._tag === "Some" ? { maxConcurrency: maxConcurrency.value } : {}),
          resume
        })
        const consumeEvents = (async () => {
          for await (const event of handle.events) {
            console.log(renderEvent(eventMode, event))
          }
        })()
        const result = await handle.result
        await consumeEvents
        console.log(
          JSON.stringify(
            {
              runId: result.runId,
              status: result.status,
              criticalPathMs: result.criticalPathMs,
              runRoot: result.runRoot,
              usage: result.projection.usage
            },
            null,
            eventMode === "json" ? 0 : 2
          )
        )

        if (result.status === "failed") {
          throw new Error("One or more tasks failed during execution")
        }
      })
  ).pipe(Command.withDescription("Execute a supplied Dagger v1 YAML plan"))

export const makeCli = () =>
  Command.make("dagger").pipe(
    Command.withDescription("Event-sourced DAG execution engine for agent chats"),
    Command.withSubcommands([makeRunCommand()])
  )

export const makeProgram = () => Command.run(makeCli(), { version })
