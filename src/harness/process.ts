import { Effect } from "effect"

import { HarnessError } from "./harness"

export type HarnessCommandResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export const compactStrings = (parts: ReadonlyArray<string | undefined>) =>
  parts.filter((part): part is string => part !== undefined && part.length > 0)

export const tokenizeArgs = (value: string | undefined) =>
  value === undefined ? [] : value.split(/\s+/).filter((token) => token.length > 0)

export const runHarnessCommand = (options: {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly stdin: string
}) =>
  Effect.tryPromise({
    try: async () => {
      const subprocess = Bun.spawn([options.command, ...options.args], {
        cwd: options.cwd,
        env: process.env,
        stdin: new Blob([options.stdin]),
        stdout: "pipe",
        stderr: "pipe"
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text()
      ])

      return {
        exitCode,
        stdout,
        stderr
      } satisfies HarnessCommandResult
    },
    catch: (error) =>
      new HarnessError({
        message: error instanceof Error ? error.message : "Unable to start harness command"
      })
  })

export const ensureSuccessfulExit = (
  result: HarnessCommandResult,
  commandLabel = "Harness command"
) =>
  result.exitCode === 0
    ? Effect.succeed(result)
    : Effect.fail(
        new HarnessError({
          message: compactStrings([
            `${commandLabel} failed with exit code ${result.exitCode}.`,
            result.stderr.trim()
          ]).join("\n")
        })
      )
