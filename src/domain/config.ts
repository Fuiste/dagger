import { Effect, Option, Schema } from "effect"

export const HarnessNameSchema = Schema.Literals(["cursor", "codex"])
export type HarnessName = typeof HarnessNameSchema.Type

export const ThinkingLevelSchema = Schema.Literals(["low", "medium", "high"])
export type ThinkingLevel = typeof ThinkingLevelSchema.Type

export class RunConfig extends Schema.Class<RunConfig>("RunConfig")({
  planPath: Schema.String,
  harness: HarnessNameSchema,
  model: Schema.optional(Schema.String),
  thinking: Schema.optional(ThinkingLevelSchema),
  maxConcurrency: Schema.optional(Schema.Int),
  dryRun: Schema.Boolean,
  cwd: Schema.String
}) {}

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()("ConfigError", {
  message: Schema.String
}) {}

export type DoCommandInput = {
  readonly planPath: string
  readonly harness: HarnessName
  readonly model: Option.Option<string>
  readonly thinking: Option.Option<ThinkingLevel>
  readonly maxConcurrency: Option.Option<number>
  readonly dryRun: boolean
  readonly cwd: string
}

const optionToUndefined = <A>(option: Option.Option<A>): A | undefined =>
  Option.match(option, {
    onNone: () => undefined,
    onSome: (value) => value
  })

export const decodeRunConfig = (input: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(RunConfig)(input),
    catch: (error) =>
      new ConfigError({
        message: error instanceof Error ? error.message : "Invalid run configuration"
      })
  })

export const makeRunConfig = (input: DoCommandInput) =>
  decodeRunConfig({
    planPath: input.planPath,
    harness: input.harness,
    model: optionToUndefined(input.model),
    thinking: optionToUndefined(input.thinking),
    maxConcurrency: optionToUndefined(input.maxConcurrency),
    dryRun: input.dryRun,
    cwd: input.cwd
  })
