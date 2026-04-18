import { resolve } from "node:path"

const benchmarkRepoRoot = resolve(import.meta.dir, "../..")

export const benchmarkCliEntry = resolve(benchmarkRepoRoot, "src/index.ts")

export const makeDaggerCliInvocation = (options: {
  readonly cwd: string
  readonly planPath: string
  readonly harness: string
  readonly model: string
  readonly dryRun?: boolean
  readonly maxConcurrency?: number
}) => ({
  argv: [
    "bun",
    benchmarkCliEntry,
    "do",
    options.planPath,
    "--harness",
    options.harness,
    "--model",
    options.model,
    "--max-concurrency",
    String(options.maxConcurrency ?? 3),
    ...(options.dryRun === true ? ["--dry-run"] : []),
  ],
  cwd: options.cwd,
})
