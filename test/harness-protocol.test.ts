import { describe, expect, test } from "bun:test"
import { Option } from "effect"

import {
  TaskFinishNoteEvent,
  TaskStartNoteEvent,
  harnessEventPrefix,
  parseHarnessEventLine,
  parseHarnessOutput
} from "../src/harness/protocol"

describe("parseHarnessEventLine", () => {
  test("decodes protocol events from prefixed json lines", () => {
    const event = parseHarnessEventLine(
      `${harnessEventPrefix}{"_tag":"TaskStartNoteEvent","note":"starting work"}`
    )

    expect(Option.isSome(event)).toBe(true)
    expect(Option.getOrUndefined(event)).toEqual(new TaskStartNoteEvent({ note: "starting work" }))
  })
})

describe("parseHarnessOutput", () => {
  test("separates structured events from plain stdout", () => {
    const parsed = parseHarnessOutput(
      [
        `${harnessEventPrefix}{"_tag":"TaskStartNoteEvent","note":"starting work"}`,
        "working...",
        `${harnessEventPrefix}{"_tag":"TaskFinishNoteEvent","note":"finished work","summary":"task complete"}`,
        "final plain summary"
      ].join("\n")
    )

    expect(parsed.events).toEqual([
      new TaskStartNoteEvent({ note: "starting work" }),
      new TaskFinishNoteEvent({ note: "finished work", summary: "task complete" })
    ])
    expect(parsed.plainText).toEqual(["working...", "final plain summary"])
  })
})
