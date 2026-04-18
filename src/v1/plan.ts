import { dirname, resolve } from "node:path"

import YAML from "yaml"

export type Provider = "codex" | "cursor"
export type RuntimeProfile = "fast" | "balanced" | "thorough" | "cheap"
export type TaskKind = "model" | "command" | "reduce" | "assert"
export type TaskRole =
  | "designer"
  | "frontend_implementer"
  | "backend_implementer"
  | "reviewer"
  | "cheap_reader"
export type ArtifactFormat = "json" | "text" | "markdown" | "patch" | "junit"
export type ReduceOperation = "json-merge" | "json-array" | "text-concat"

export type PlanDefaults = {
  readonly cwd?: string
  readonly profile?: RuntimeProfile
  readonly artifactsDir?: string
  readonly provider?: Provider | "auto"
}

export type ArtifactRef = {
  readonly taskId: string
  readonly artifactId: string
}

export type TaskInputs = {
  readonly files?: ReadonlyArray<string>
  readonly artifacts?: ReadonlyArray<ArtifactRef>
}

export type OutputArtifactSpec = {
  readonly id: string
  readonly path: string
  readonly format: ArtifactFormat
}

export type ModelTask = {
  readonly id: string
  readonly kind: "model"
  readonly dependsOn?: ReadonlyArray<string>
  readonly inputs?: TaskInputs
  readonly outputs: ReadonlyArray<OutputArtifactSpec>
  readonly prompt: string
  readonly role: TaskRole
  readonly provider?: Provider
  readonly model?: string
}

export type CommandTask = {
  readonly id: string
  readonly kind: "command"
  readonly dependsOn?: ReadonlyArray<string>
  readonly inputs?: TaskInputs
  readonly outputs?: ReadonlyArray<OutputArtifactSpec>
  readonly command: string
}

export type ReduceTask = {
  readonly id: string
  readonly kind: "reduce"
  readonly dependsOn?: ReadonlyArray<string>
  readonly inputs: TaskInputs
  readonly outputs: ReadonlyArray<OutputArtifactSpec>
  readonly operation: ReduceOperation
}

export type AssertTask = {
  readonly id: string
  readonly kind: "assert"
  readonly dependsOn?: ReadonlyArray<string>
  readonly inputs?: TaskInputs
  readonly outputs?: ReadonlyArray<OutputArtifactSpec>
  readonly commands?: ReadonlyArray<string>
  readonly requiredArtifacts?: ReadonlyArray<ArtifactRef>
  readonly allowedChangedFiles?: ReadonlyArray<string>
}

export type PlanTask = ModelTask | CommandTask | ReduceTask | AssertTask

export type DaggerPlan = {
  readonly version: 1
  readonly defaults?: PlanDefaults
  readonly tasks: ReadonlyArray<PlanTask>
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PlanError"
  }
}

export type ResolvedPlan = {
  readonly planPath: string
  readonly rootDir: string
  readonly cwd: string
  readonly profile: RuntimeProfile
  readonly artifactsDir: string
  readonly providerPreference: Provider | "auto"
  readonly plan: DaggerPlan
}

const providers = new Set<Provider>(["codex", "cursor"])
const profiles = new Set<RuntimeProfile>(["fast", "balanced", "thorough", "cheap"])
const roles = new Set<TaskRole>([
  "designer",
  "frontend_implementer",
  "backend_implementer",
  "reviewer",
  "cheap_reader"
])
const formats = new Set<ArtifactFormat>(["json", "text", "markdown", "patch", "junit"])
const reduceOperations = new Set<ReduceOperation>(["json-merge", "json-array", "text-concat"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const readString = (value: unknown, label: string) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new PlanError(`${label} must be a non-empty string`)
  }

  return value
}

const readStringArray = (value: unknown, label: string) => {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new PlanError(`${label} must be an array of non-empty strings`)
  }

  return value
}

const readArtifactRef = (value: unknown, label: string): ArtifactRef => {
  if (!isRecord(value)) {
    throw new PlanError(`${label} must be an object`)
  }

  return {
    taskId: readString(value.taskId, `${label}.taskId`),
    artifactId: readString(value.artifactId, `${label}.artifactId`)
  }
}

const readArtifactRefArray = (value: unknown, label: string) => {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    throw new PlanError(`${label} must be an array`)
  }

  return value.map((entry, index) => readArtifactRef(entry, `${label}[${index}]`))
}

const readInputs = (value: unknown, label: string): TaskInputs | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (!isRecord(value)) {
    throw new PlanError(`${label} must be an object`)
  }

  const files = readStringArray(value.files, `${label}.files`)
  const artifacts = readArtifactRefArray(value.artifacts, `${label}.artifacts`)

  return {
    ...(files === undefined ? {} : { files }),
    ...(artifacts === undefined ? {} : { artifacts })
  }
}

const readOutput = (value: unknown, label: string): OutputArtifactSpec => {
  if (!isRecord(value)) {
    throw new PlanError(`${label} must be an object`)
  }

  const format = readString(value.format, `${label}.format`)

  if (!formats.has(format as ArtifactFormat)) {
    throw new PlanError(`${label}.format must be one of ${[...formats].join(", ")}`)
  }

  return {
    id: readString(value.id, `${label}.id`),
    path: readString(value.path, `${label}.path`),
    format: format as ArtifactFormat
  }
}

const readOutputs = (value: unknown, label: string, required: boolean) => {
  if (value === undefined) {
    if (required) {
      throw new PlanError(`${label} is required`)
    }

    return undefined
  }

  if (!Array.isArray(value)) {
    throw new PlanError(`${label} must be an array`)
  }

  return value.map((entry, index) => readOutput(entry, `${label}[${index}]`))
}

const readTask = (value: unknown, label: string): PlanTask => {
  if (!isRecord(value)) {
    throw new PlanError(`${label} must be an object`)
  }

  const kind = readString(value.kind, `${label}.kind`)
  const id = readString(value.id, `${label}.id`)
  const dependsOn = readStringArray(value.dependsOn, `${label}.dependsOn`)
  const inputs = readInputs(value.inputs, `${label}.inputs`)

  switch (kind) {
    case "model": {
      const role = readString(value.role, `${label}.role`)
      const provider = value.provider === undefined ? undefined : readString(value.provider, `${label}.provider`)

      if (!roles.has(role as TaskRole)) {
        throw new PlanError(`${label}.role must be one of ${[...roles].join(", ")}`)
      }

      if (provider !== undefined && !providers.has(provider as Provider)) {
        throw new PlanError(`${label}.provider must be one of ${[...providers].join(", ")}`)
      }

      return {
        id,
        kind: "model",
        ...(dependsOn === undefined ? {} : { dependsOn }),
        ...(inputs === undefined ? {} : { inputs }),
        outputs: readOutputs(value.outputs, `${label}.outputs`, true) ?? [],
        prompt: readString(value.prompt, `${label}.prompt`),
        role: role as TaskRole,
        ...(provider === undefined ? {} : { provider: provider as Provider }),
        ...(value.model === undefined ? {} : { model: readString(value.model, `${label}.model`) })
      }
    }
    case "command":
      {
      const outputs = readOutputs(value.outputs, `${label}.outputs`, false)
      return {
        id,
        kind: "command",
        ...(dependsOn === undefined ? {} : { dependsOn }),
        ...(inputs === undefined ? {} : { inputs }),
        ...(outputs === undefined ? {} : { outputs }),
        command: readString(value.command, `${label}.command`)
      }
      }
    case "reduce": {
      const operation = readString(value.operation, `${label}.operation`)

      if (!reduceOperations.has(operation as ReduceOperation)) {
        throw new PlanError(
          `${label}.operation must be one of ${[...reduceOperations].join(", ")}`
        )
      }

      return {
        id,
        kind: "reduce",
        ...(dependsOn === undefined ? {} : { dependsOn }),
        inputs: readInputs(value.inputs, `${label}.inputs`) ?? {},
        outputs: readOutputs(value.outputs, `${label}.outputs`, true) ?? [],
        operation: operation as ReduceOperation
      }
    }
    case "assert":
      {
      const outputs = readOutputs(value.outputs, `${label}.outputs`, false)
      const commands = readStringArray(value.commands, `${label}.commands`)
      const requiredArtifacts = readArtifactRefArray(value.requiredArtifacts, `${label}.requiredArtifacts`)
      const allowedChangedFiles = readStringArray(value.allowedChangedFiles, `${label}.allowedChangedFiles`)
      return {
        id,
        kind: "assert",
        ...(dependsOn === undefined ? {} : { dependsOn }),
        ...(inputs === undefined ? {} : { inputs }),
        ...(outputs === undefined ? {} : { outputs }),
        ...(commands === undefined ? {} : { commands }),
        ...(requiredArtifacts === undefined ? {} : { requiredArtifacts }),
        ...(allowedChangedFiles === undefined ? {} : { allowedChangedFiles })
      }
      }
    default:
      throw new PlanError(`${label}.kind must be one of model, command, reduce, assert`)
  }
}

const validatePlan = (plan: DaggerPlan) => {
  const ids = new Set<string>()
  const outputsByTask = new Map<string, Set<string>>()

  for (const task of plan.tasks) {
    if (ids.has(task.id)) {
      throw new PlanError(`Duplicate task id "${task.id}"`)
    }

    ids.add(task.id)
    const outputs = "outputs" in task ? task.outputs ?? [] : []
    const outputIds = new Set<string>()

    for (const output of outputs) {
      if (outputIds.has(output.id)) {
        throw new PlanError(`Task "${task.id}" declares duplicate output "${output.id}"`)
      }

      outputIds.add(output.id)
    }

    outputsByTask.set(task.id, outputIds)

    if ((task.kind === "model" || task.kind === "reduce") && outputs.length === 0) {
      throw new PlanError(`Task "${task.id}" must declare at least one output`)
    }
  }

  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        throw new PlanError(`Task "${task.id}" depends on missing task "${dependency}"`)
      }
    }

    const refs = [...(task.inputs?.artifacts ?? []), ...(task.kind === "assert" ? task.requiredArtifacts ?? [] : [])]

    for (const ref of refs) {
      const outputIds = outputsByTask.get(ref.taskId)

      if (outputIds === undefined || !outputIds.has(ref.artifactId)) {
        throw new PlanError(`Task "${task.id}" references missing artifact "${ref.taskId}.${ref.artifactId}"`)
      }
    }
  }
}

export const parsePlanYaml = (source: string): DaggerPlan => {
  const parsed = YAML.parse(source)

  if (!isRecord(parsed)) {
    throw new PlanError("Plan YAML must decode to an object")
  }

  const version = parsed.version

  if (version !== 1) {
    throw new PlanError("Plan version must be 1")
  }

  const defaults = parsed.defaults
  let normalizedDefaults: PlanDefaults | undefined

  if (defaults !== undefined) {
    if (!isRecord(defaults)) {
      throw new PlanError("defaults must be an object")
    }

    const provider = defaults.provider === undefined ? undefined : readString(defaults.provider, "defaults.provider")
    const profile = defaults.profile === undefined ? undefined : readString(defaults.profile, "defaults.profile")

    if (provider !== undefined && provider !== "auto" && !providers.has(provider as Provider)) {
      throw new PlanError(`defaults.provider must be auto or one of ${[...providers].join(", ")}`)
    }

    if (profile !== undefined && !profiles.has(profile as RuntimeProfile)) {
      throw new PlanError(`defaults.profile must be one of ${[...profiles].join(", ")}`)
    }

    normalizedDefaults = {
      ...(defaults.cwd === undefined ? {} : { cwd: readString(defaults.cwd, "defaults.cwd") }),
      ...(profile === undefined ? {} : { profile: profile as RuntimeProfile }),
      ...(defaults.artifactsDir === undefined
        ? {}
        : { artifactsDir: readString(defaults.artifactsDir, "defaults.artifactsDir") }),
      ...(provider === undefined ? {} : { provider: provider as Provider | "auto" })
    }
  }

  if (!Array.isArray(parsed.tasks)) {
    throw new PlanError("tasks must be an array")
  }

  const plan: DaggerPlan = {
    version: 1,
    ...(normalizedDefaults === undefined ? {} : { defaults: normalizedDefaults }),
    tasks: parsed.tasks.map((task, index) => readTask(task, `tasks[${index}]`))
  }

  validatePlan(plan)

  return plan
}

export const resolvePlan = (options: {
  readonly planPath: string
  readonly source: string
  readonly cwd: string
  readonly profile?: RuntimeProfile
  readonly artifactsDir?: string
}): ResolvedPlan => {
  const plan = parsePlanYaml(options.source)
  const absolutePlanPath = resolve(options.cwd, options.planPath)
  const rootDir = dirname(absolutePlanPath)
  const cwd = resolve(rootDir, plan.defaults?.cwd ?? options.cwd)

  return {
    planPath: absolutePlanPath,
    rootDir,
    cwd,
    profile: options.profile ?? plan.defaults?.profile ?? "balanced",
    artifactsDir: resolve(cwd, options.artifactsDir ?? plan.defaults?.artifactsDir ?? ".dagger/runs"),
    providerPreference: plan.defaults?.provider ?? "auto",
    plan
  }
}

export const taskDependsOn = (task: PlanTask) => task.dependsOn ?? []

export const computeExecutionLevels = (plan: DaggerPlan) => {
  const remainingDeps = new Map(plan.tasks.map((task) => [task.id, new Set(taskDependsOn(task))] as const))
  const unresolved = new Set(plan.tasks.map((task) => task.id))
  const levels: Array<Array<string>> = []

  while (unresolved.size > 0) {
    const ready = plan.tasks
      .map((task) => task.id)
      .filter((taskId) => unresolved.has(taskId) && (remainingDeps.get(taskId)?.size ?? 0) === 0)

    if (ready.length === 0) {
      throw new PlanError("Plan contains a cycle")
    }

    levels.push(ready)

    for (const taskId of ready) {
      unresolved.delete(taskId)

      for (const deps of remainingDeps.values()) {
        deps.delete(taskId)
      }
    }
  }

  return levels
}
