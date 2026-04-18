#!/usr/bin/env bun

import { runBenchmarkWrapper } from "../src/benchmark/wrapper.ts"

await runBenchmarkWrapper({
  command: process.env.DAGGER_BENCH_CODEX_COMMAND ?? "codex",
  label: "codex",
})
