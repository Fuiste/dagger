import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { compactStrings, tokenizeArgs } from "../harness/process"
import { type Provider } from "./plan"

export type ModelExecutionResult = {
  readonly stdout: string
  readonly stderr: string
  readonly assistantMessage: string
}

const defaultCodexCommand = "codex"
const defaultCursorCommand = "cursor-agent"

const codexBaseArgs = ["exec", "--full-auto", "--ephemeral", "--skip-git-repo-check", "--color", "never"]
const cursorBaseArgs = ["-p", "--force", "--output-format", "text"]

const runProcess = async (options: {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly stdin: string
}) => {
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
  }
}

export const runModelProvider = async (options: {
  readonly provider: Provider
  readonly model: string
  readonly cwd: string
  readonly prompt: string
}) => {
  if (options.provider === "codex") {
    const directory = await mkdtemp(join(tmpdir(), "dagger-v1-codex-"))
    const outputPath = join(directory, "assistant.txt")

    try {
      const result = await runProcess({
        command: process.env.DAGGER_CODEX_COMMAND ?? defaultCodexCommand,
        args: compactStrings([
          ...codexBaseArgs,
          ...tokenizeArgs(process.env.DAGGER_CODEX_EXTRA_ARGS),
          "--cd",
          options.cwd,
          "--model",
          options.model,
          "-o",
          outputPath
        ]),
        cwd: options.cwd,
        stdin: options.prompt
      })

      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `Codex failed with exit code ${result.exitCode}`)
      }

      const assistantMessage = await readFile(outputPath, "utf8")

      if (assistantMessage.trim().length === 0) {
        throw new Error("Codex did not write a final assistant message")
      }

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        assistantMessage
      } satisfies ModelExecutionResult
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  const result = await runProcess({
    command: process.env.DAGGER_CURSOR_COMMAND ?? defaultCursorCommand,
    args: compactStrings([
      ...cursorBaseArgs,
      ...tokenizeArgs(process.env.DAGGER_CURSOR_EXTRA_ARGS),
      "--model",
      options.model
    ]),
    cwd: options.cwd,
    stdin: options.prompt
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Cursor failed with exit code ${result.exitCode}`)
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    assistantMessage: result.stdout
  } satisfies ModelExecutionResult
}
