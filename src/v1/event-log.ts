import { appendFile, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { applyRunEvent, makeInitialProjection, type RunEvent, type RunProjection } from "./events"
import { type DaggerPlan, type RuntimeProfile } from "./plan"

export type RunPaths = {
  readonly runRoot: string
  readonly eventsPath: string
  readonly projectionPath: string
  readonly transcriptsDir: string
  readonly cacheDir: string
  readonly planIndexDir: string
}

const ensureParent = async (path: string) => {
  await mkdir(dirname(path), { recursive: true })
}

const encodeEvent = (event: RunEvent) => JSON.stringify(event)

export const makeRunPaths = (cwd: string, artifactsDir: string, runId: string): RunPaths => ({
  runRoot: resolve(artifactsDir, runId),
  eventsPath: resolve(artifactsDir, runId, "events.ndjson"),
  projectionPath: resolve(artifactsDir, runId, "projection.json"),
  transcriptsDir: resolve(artifactsDir, runId, "transcripts"),
  cacheDir: resolve(cwd, ".dagger/cache/tasks"),
  planIndexDir: resolve(cwd, ".dagger/plan-index")
})

export const initializeRunStore = async (paths: RunPaths) => {
  await mkdir(paths.runRoot, { recursive: true })
  await mkdir(paths.transcriptsDir, { recursive: true })
  await mkdir(paths.cacheDir, { recursive: true })
  await mkdir(paths.planIndexDir, { recursive: true })
}

export const appendEvent = async (
  paths: RunPaths,
  projection: RunProjection,
  event: RunEvent
) => {
  await ensureParent(paths.eventsPath)
  await appendFile(paths.eventsPath, `${encodeEvent(event)}\n`)
  const nextProjection = applyRunEvent(projection, event)
  await writeFile(paths.projectionPath, `${JSON.stringify(nextProjection, null, 2)}\n`)
  return nextProjection
}

const decodeEventLine = (line: string): RunEvent =>
  JSON.parse(line) as RunEvent

export const loadProjectionFromEvents = async (options: {
  readonly paths: RunPaths
  readonly runId: string
  readonly cwd: string
  readonly profile: RuntimeProfile
  readonly planPath: string
  readonly plan: DaggerPlan
}) => {
  const initial = makeInitialProjection({
    runId: options.runId,
    cwd: options.cwd,
    profile: options.profile,
    planPath: options.planPath,
    tasks: options.plan.tasks.map((task) => ({
      id: task.id,
      kind: task.kind,
      ...(task.kind === "model" ? { role: task.role } : {})
    }))
  })

  const exists = await Bun.file(options.paths.eventsPath).exists()

  if (!exists) {
    return initial
  }

  const source = await readFile(options.paths.eventsPath, "utf8")
  return source
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(decodeEventLine)
    .reduce(applyRunEvent, initial)
}

export const writeTranscriptFiles = async (options: {
  readonly paths: RunPaths
  readonly taskId: string
  readonly stdout: string
  readonly stderr: string
  readonly assistantMessage?: string
}) => {
  const taskDir = join(options.paths.transcriptsDir, options.taskId)
  await mkdir(taskDir, { recursive: true })
  await writeFile(join(taskDir, "stdout.txt"), options.stdout)
  await writeFile(join(taskDir, "stderr.txt"), options.stderr)

  if (options.assistantMessage !== undefined) {
    await writeFile(join(taskDir, "assistant.txt"), options.assistantMessage)
  }
}

export const copyToCache = async (options: {
  readonly cacheRoot: string
  readonly outputs: ReadonlyArray<{ readonly relativePath: string }>
  readonly cwd: string
}) => {
  await mkdir(join(options.cacheRoot, "output"), { recursive: true })

  for (const output of options.outputs) {
    const source = resolve(options.cwd, output.relativePath)
    const target = join(options.cacheRoot, "output", output.relativePath)
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { force: true })
  }
}

export const restoreFromCache = async (options: {
  readonly cacheRoot: string
  readonly outputs: ReadonlyArray<{ readonly relativePath: string }>
  readonly cwd: string
}) => {
  for (const output of options.outputs) {
    const source = join(options.cacheRoot, "output", output.relativePath)
    const target = resolve(options.cwd, output.relativePath)
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { force: true })
  }
}

export const writeCacheManifest = async (options: {
  readonly cacheRoot: string
  readonly cacheKey: string
  readonly taskId: string
}) => {
  await mkdir(options.cacheRoot, { recursive: true })
  await writeFile(
    join(options.cacheRoot, "manifest.json"),
    `${JSON.stringify({ cacheKey: options.cacheKey, taskId: options.taskId }, null, 2)}\n`
  )
}

export const hasCacheEntry = async (cacheRoot: string) => Bun.file(join(cacheRoot, "manifest.json")).exists()

export const statFile = async (path: string) => stat(path)

export const readJsonFile = async <A>(path: string): Promise<A> =>
  JSON.parse(await readFile(path, "utf8")) as A

export const writePlanIndex = async (options: {
  readonly paths: RunPaths
  readonly planDigest: string
  readonly runId: string
}) => {
  await mkdir(options.paths.planIndexDir, { recursive: true })
  await writeFile(
    join(options.paths.planIndexDir, `${options.planDigest}.json`),
    `${JSON.stringify({ runId: options.runId }, null, 2)}\n`
  )
}

export const readPlanIndex = async (options: {
  readonly paths: RunPaths
  readonly planDigest: string
}) => {
  const path = join(options.paths.planIndexDir, `${options.planDigest}.json`)
  const exists = await Bun.file(path).exists()

  if (!exists) {
    return undefined
  }

  return readJsonFile<{ readonly runId: string }>(path)
}
