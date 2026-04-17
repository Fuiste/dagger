import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { Command } from "effect/unstable/cli"

import { makeCli } from "../src/cli/do"
import { makeRunConfig } from "../src/domain/config"

const compact = <A extends Record<string, unknown>>(record: A) =>
  Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  )

describe("makeRunConfig", () => {
  test("applies defaults from decoded CLI input", async () => {
    const config = await Effect.runPromise(
      makeRunConfig({
        planPath: "plan.md",
        harness: "cursor",
        model: Option.none(),
        thinking: Option.none(),
        maxConcurrency: Option.none(),
        dryRun: false,
        cwd: "/workspace/dagger"
      })
    )

    expect(compact({ ...config })).toEqual({
      cwd: "/workspace/dagger",
      dryRun: false,
      harness: "cursor",
      planPath: "plan.md"
    })
  })
})

describe("makeCli", () => {
  test("parses dagger do argv into a run config", async () => {
    let captured: Record<string, unknown> | undefined

    const program = Command.runWith(makeCli((config) =>
      Effect.sync(() => {
        captured = { ...config }
      })
    ), { version: "0.1.0" })

    await Effect.runPromise(
      program([
        "do",
        "plan.md",
        "--dry-run",
        "--model",
        "gpt-5",
        "--thinking",
        "high",
        "--max-concurrency",
        "3"
      ])
        .pipe(Effect.provide(BunServices.layer))
    )

    expect(captured).toEqual({
      cwd: process.cwd(),
      dryRun: true,
      harness: "cursor",
      maxConcurrency: 3,
      model: "gpt-5",
      planPath: "plan.md",
      thinking: "high"
    })
  })
})
