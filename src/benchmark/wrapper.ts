import { mkdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

type WrapperRecord = {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly exitCode: number
  readonly durationMs: number
  readonly startedAt: string
  readonly stdout: string
  readonly stderr: string
}

const readStdin = async () => {
  const chunks: Uint8Array[] = []

  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk)
  }

  return chunks.length === 0 ? "" : Buffer.concat(chunks).toString("utf8")
}

const ensureDir = async (directory: string | undefined) => {
  if (directory === undefined || directory.length === 0) {
    return undefined
  }

  await mkdir(directory, { recursive: true })
  return directory
}

const writeTelemetry = async (
  directory: string | undefined,
  label: string,
  record: WrapperRecord
) => {
  const targetDir = await ensureDir(directory)

  if (targetDir === undefined) {
    return
  }

  const filename = `${Date.now()}-${process.pid}-${label}-${crypto.randomUUID()}.json`
  await writeFile(join(targetDir, filename), `${JSON.stringify(record, null, 2)}\n`)
}

export const runBenchmarkWrapper = async (options: {
  readonly command: string
  readonly label: string
}) => {
  const stdin = await readStdin()
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const subprocess = Bun.spawn([options.command, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: process.env,
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])
  const durationMs = performance.now() - started

  process.stdout.write(stdout)
  process.stderr.write(stderr)

  await writeTelemetry(process.env.DAGGER_BENCH_TELEMETRY_DIR, options.label, {
    command: options.command,
    args: process.argv.slice(2),
    cwd: process.cwd(),
    exitCode,
    durationMs,
    startedAt,
    stdout,
    stderr,
  })

  process.exit(exitCode)
}

export const inferredWrapperLabel = () => basename(process.argv[1] ?? "wrapper")
