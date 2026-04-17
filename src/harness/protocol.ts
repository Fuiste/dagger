import { Option, Schema } from "effect"

import { type HarnessTaskResult } from "./harness"

export const harnessEventPrefix = "DAGGER_EVENT "

export class TaskStartNoteEvent extends Schema.TaggedClass<TaskStartNoteEvent>()("TaskStartNoteEvent", {
  note: Schema.String
}) {}

export class TaskFinishNoteEvent extends Schema.TaggedClass<TaskFinishNoteEvent>()("TaskFinishNoteEvent", {
  note: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String)
}) {}

export const HarnessEventSchema = Schema.Union([
  TaskStartNoteEvent,
  TaskFinishNoteEvent
])
export type HarnessEvent = typeof HarnessEventSchema.Type

export const parseHarnessEventLine = (line: string): Option.Option<HarnessEvent> => {
  if (!line.startsWith(harnessEventPrefix)) {
    return Option.none()
  }

  try {
    return Option.some(
      Schema.decodeUnknownSync(HarnessEventSchema)(JSON.parse(line.slice(harnessEventPrefix.length)))
    )
  } catch {
    return Option.none()
    }
}

export const parseAssistantMessage = (message: string) =>
  message.split(/\r?\n/).reduce(
    (state, line) => {
      const event = parseHarnessEventLine(line)

      return Option.match(event, {
        onNone: () => ({
          events: state.events,
          plainText: line.trim().length === 0 ? state.plainText : [...state.plainText, line]
        }),
        onSome: (decodedEvent) => ({
          events: [...state.events, decodedEvent],
          plainText: state.plainText
        })
      })
    },
    {
      events: [] as Array<HarnessEvent>,
      plainText: [] as Array<string>
    }
  )

export const parseHarnessOutput = parseAssistantMessage

const compactTaskResult = (result: {
  readonly note: string | undefined
  readonly summary: string | undefined
}): HarnessTaskResult => ({
  ...(result.note === undefined ? {} : { note: result.note }),
  ...(result.summary === undefined ? {} : { summary: result.summary })
})

const findLastEvent = <A>(
  values: ReadonlyArray<A>,
  predicate: (value: A) => boolean
) => [...values].reverse().find(predicate)

export const taskResultFromAssistantMessage = (message: string): HarnessTaskResult => {
  const parsed = parseAssistantMessage(message)
  const startNote = parsed.events.find((event) => event instanceof TaskStartNoteEvent)
  const finishNote = findLastEvent(
    parsed.events,
    (event): event is TaskFinishNoteEvent => event instanceof TaskFinishNoteEvent
  )
  const summaryText = parsed.plainText.join("\n").trim()

  return compactTaskResult({
    note:
      finishNote instanceof TaskFinishNoteEvent
        ? finishNote.note
        : startNote instanceof TaskStartNoteEvent
          ? startNote.note
          : undefined,
    summary:
      finishNote instanceof TaskFinishNoteEvent
        ? finishNote.summary ?? summaryText
        : summaryText.length > 0
          ? summaryText
          : undefined
  })
}

export const summaryFromAssistantMessage = (message: string) => {
  const parsed = parseAssistantMessage(message)
  const finishNote = findLastEvent(
    parsed.events,
    (event): event is TaskFinishNoteEvent => event instanceof TaskFinishNoteEvent
  )
  const summaryText = parsed.plainText.join("\n").trim()

  return finishNote instanceof TaskFinishNoteEvent
    ? finishNote.summary ?? finishNote.note ?? summaryText
    : summaryText
}
