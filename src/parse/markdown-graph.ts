import { Effect } from "effect"

import {
  TaskDefinition,
  TaskDependency,
  type TaskGraph,
  TaskGraphError,
  computeExecutionLevels,
  decodeTaskGraph,
  failTaskGraph,
  makeTaskMap
} from "../domain/task-graph"

type RawMarkdownBlock =
  | {
      readonly _tag: "Paragraph"
      readonly text: string
    }
  | {
      readonly _tag: "BulletList"
      readonly items: ReadonlyArray<string>
    }
  | {
      readonly _tag: "CodeBlock"
      readonly info: string
      readonly content: string
    }

type RawMarkdownSection = {
  readonly level: number
  readonly title: string
  readonly blocks: ReadonlyArray<RawMarkdownBlock>
  readonly children: ReadonlyArray<RawMarkdownSection>
}

type RawMarkdownDocument = {
  readonly sections: ReadonlyArray<RawMarkdownSection>
}

type MutableRawMarkdownSection = {
  level: number
  title: string
  blocks: Array<RawMarkdownBlock>
  children: Array<MutableRawMarkdownSection>
}

const taskIdPattern = /^[a-z0-9][a-z0-9-_]*$/i

const formatCodeBlock = (info: string, content: string) =>
  ["```" + info, content, "```"].join("\n").trim()

const parseRawMarkdownDocument = (markdown: string) =>
  Effect.try({
    try: () => {
      const root: MutableRawMarkdownSection = {
        level: 0,
        title: "root",
        blocks: [],
        children: []
      }
      const stack: Array<MutableRawMarkdownSection> = [root]
      const lines = markdown.split(/\r?\n/)
      let paragraphLines: Array<string> = []
      let listItems: Array<string> = []

      const flushParagraph = () => {
        if (paragraphLines.length === 0) {
          return
        }

        stack.at(-1)?.blocks.push({
          _tag: "Paragraph",
          text: paragraphLines.join("\n").trim()
        })
        paragraphLines = []
      }

      const flushList = () => {
        if (listItems.length === 0) {
          return
        }

        stack.at(-1)?.blocks.push({
          _tag: "BulletList",
          items: [...listItems]
        })
        listItems = []
      }

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ""
        const trimmed = line.trim()

        if (trimmed.startsWith("```")) {
          flushParagraph()
          flushList()

          const info = trimmed.slice(3).trim()
          const contentLines: Array<string> = []

          index += 1

          while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
            contentLines.push(lines[index] ?? "")
            index += 1
          }

          stack.at(-1)?.blocks.push({
            _tag: "CodeBlock",
            info,
            content: contentLines.join("\n").trimEnd()
          })
          continue
        }

        const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(trimmed)

        if (headingMatch !== null) {
          flushParagraph()
          flushList()

          const level = headingMatch.at(1)?.length ?? 0

          if (level === 1) {
            continue
          }

          if (level > 3) {
            paragraphLines.push(trimmed)
            continue
          }

          while ((stack.at(-1)?.level ?? 0) >= level) {
            stack.pop()
          }

          const section: MutableRawMarkdownSection = {
            level,
            title: headingMatch.at(2)?.trim() ?? "",
            blocks: [],
            children: []
          }

          stack.at(-1)?.children.push(section)
          stack.push(section)
          continue
        }

        const bulletMatch = /^-\s+(.+?)\s*$/.exec(trimmed)

        if (bulletMatch !== null) {
          flushParagraph()
          listItems.push(bulletMatch.at(1)?.trim() ?? "")
          continue
        }

        if (trimmed.length === 0) {
          flushParagraph()
          flushList()
          continue
        }

        flushList()
        paragraphLines.push(line)
      }

      flushParagraph()
      flushList()

      const freezeSection = (section: MutableRawMarkdownSection): RawMarkdownSection => ({
        level: section.level,
        title: section.title,
        blocks: [...section.blocks],
        children: section.children.map(freezeSection)
      })

      return {
        sections: root.children.map(freezeSection)
      } satisfies RawMarkdownDocument
    },
    catch: (error) =>
      new TaskGraphError({
        message: error instanceof Error ? error.message : "Unable to parse markdown document"
      })
  })

const getTopLevelSection = (document: RawMarkdownDocument, title: string) =>
  document.sections.find((section) => section.level === 2 && section.title === title)

const parseMetadataItems = (section: RawMarkdownSection) =>
  section.blocks.reduce((entries, block) => {
    if (block._tag !== "BulletList") {
      return entries
    }

    return [...entries, ...block.items]
  }, [] as Array<string>)

const parseTaskDefinition = (section: RawMarkdownSection) =>
  Effect.gen(function*() {
    const taskId = section.title.trim()

    if (!taskIdPattern.test(taskId)) {
      return yield* new TaskGraphError({
        message: `Invalid task id "${taskId}"`
      })
    }

    const entries = parseMetadataItems(section)
    const metadata = new Map<string, string>()

    for (const entry of entries) {
      const match = /^([a-zA-Z][a-zA-Z0-9-]*):\s*(.+)$/.exec(entry)

      if (match === null) {
        return yield* new TaskGraphError({
          message: `Invalid task metadata "${entry}" in task "${taskId}"`
        })
      }

      const rawKey = match.at(1)
      const rawValue = match.at(2)

      if (rawKey === undefined || rawValue === undefined) {
        return yield* new TaskGraphError({
          message: `Invalid task metadata "${entry}" in task "${taskId}"`
        })
      }

      const key = rawKey.trim()

      if (metadata.has(key)) {
        return yield* new TaskGraphError({
          message: `Duplicate "${key}" metadata in task "${taskId}"`
        })
      }

      metadata.set(key, rawValue.trim())
    }

    const prompt = metadata.get("prompt")

    if (prompt === undefined || prompt.length === 0) {
      return yield* new TaskGraphError({
        message: `Task "${taskId}" is missing a prompt`
      })
    }

    const instructions = section.blocks
      .flatMap((block) => {
        switch (block._tag) {
          case "Paragraph":
            return [block.text.trim()]
          case "CodeBlock":
            return [formatCodeBlock(block.info, block.content)]
          case "BulletList":
            return []
        }
      })
      .filter((value) => value.length > 0)
      .join("\n\n")

    return new TaskDefinition({
      id: taskId,
      prompt,
      instructions: instructions.length > 0 ? instructions : undefined,
      harness: metadata.get("harness") as TaskDefinition["harness"],
      model: metadata.get("model"),
      thinking: metadata.get("thinking") as TaskDefinition["thinking"]
    })
  })

const parseDependencies = (section: RawMarkdownSection) =>
  Effect.forEach(
    section.blocks.flatMap((block) => (block._tag === "BulletList" ? block.items : [])),
    (entry) =>
      Effect.gen(function*() {
        const match = /^([a-z0-9][a-z0-9-_]*)\s*->\s*([a-z0-9][a-z0-9-_]*)$/i.exec(entry)

        if (match === null) {
          return yield* new TaskGraphError({
            message: `Invalid dependency "${entry}"`
          })
        }

        const from = match.at(1)
        const to = match.at(2)

        if (from === undefined || to === undefined) {
          return yield* new TaskGraphError({
            message: `Invalid dependency "${entry}"`
          })
        }

        return new TaskDependency({
          from,
          to
        })
      })
  )

const validateDependencies = (graph: TaskGraph) =>
  Effect.gen(function*() {
    const taskMap = makeTaskMap(graph)
    const edgeKeys = new Set<string>()

    for (const dependency of graph.dependencies) {
      if (!taskMap.has(dependency.from)) {
        return yield* new TaskGraphError({
          message: `Unknown dependency source "${dependency.from}"`
        })
      }

      if (!taskMap.has(dependency.to)) {
        return yield* new TaskGraphError({
          message: `Unknown dependency target "${dependency.to}"`
        })
      }

      const edgeKey = `${dependency.from}->${dependency.to}`

      if (edgeKeys.has(edgeKey)) {
        return yield* new TaskGraphError({
          message: `Duplicate dependency "${edgeKey}"`
        })
      }

      edgeKeys.add(edgeKey)
    }

    yield* computeExecutionLevels(graph)

    return graph
  })

export const parseMarkdownGraph = (markdown: string) =>
  Effect.gen(function*() {
    const document = yield* parseRawMarkdownDocument(markdown)
    const tasksSection = getTopLevelSection(document, "Tasks")
    const dependenciesSection = getTopLevelSection(document, "Dependencies")

    if (tasksSection === undefined) {
      return yield* failTaskGraph("Missing required ## Tasks section")
    }

    if (dependenciesSection === undefined) {
      return yield* failTaskGraph("Missing required ## Dependencies section")
    }

    if (tasksSection.children.length === 0) {
      return yield* failTaskGraph("The ## Tasks section must define at least one task")
    }

    const tasks = yield* Effect.forEach(tasksSection.children, parseTaskDefinition)
    const uniqueTaskIds = new Set<string>()

    for (const task of tasks) {
      if (uniqueTaskIds.has(task.id)) {
        return yield* new TaskGraphError({
          message: `Duplicate task id "${task.id}"`
        })
      }

      uniqueTaskIds.add(task.id)
    }

    const dependencies = yield* parseDependencies(dependenciesSection)
    const graph = yield* decodeTaskGraph({
      tasks,
      dependencies
    })

    return yield* validateDependencies(graph)
  })
