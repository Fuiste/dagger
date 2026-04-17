import { Option, Schema } from "effect"

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
