import { type Provider, type RuntimeProfile, type TaskRole } from "./plan"

export type ModelRoute = {
  readonly provider: Provider
  readonly model: string
}

const profileTable: Record<RuntimeProfile, Record<TaskRole, ModelRoute>> = {
  fast: {
    designer: { provider: "cursor", model: "claude-opus-4-7-high" },
    frontend_implementer: { provider: "codex", model: "gpt-5.4" },
    backend_implementer: { provider: "codex", model: "gpt-5.4" },
    reviewer: { provider: "codex", model: "gpt-5.4" },
    cheap_reader: { provider: "cursor", model: "composer-2" }
  },
  balanced: {
    designer: { provider: "cursor", model: "claude-opus-4-7-thinking-high" },
    frontend_implementer: { provider: "codex", model: "gpt-5.4" },
    backend_implementer: { provider: "codex", model: "gpt-5.4" },
    reviewer: { provider: "codex", model: "gpt-5.4" },
    cheap_reader: { provider: "cursor", model: "composer-2" }
  },
  thorough: {
    designer: { provider: "cursor", model: "claude-opus-4-7-thinking-high" },
    frontend_implementer: { provider: "codex", model: "gpt-5.4" },
    backend_implementer: { provider: "codex", model: "gpt-5.4" },
    reviewer: { provider: "codex", model: "gpt-5.4" },
    cheap_reader: { provider: "cursor", model: "claude-opus-4-7-high" }
  },
  cheap: {
    designer: { provider: "cursor", model: "composer-2" },
    frontend_implementer: { provider: "cursor", model: "composer-2" },
    backend_implementer: { provider: "cursor", model: "composer-2" },
    reviewer: { provider: "cursor", model: "composer-2" },
    cheap_reader: { provider: "cursor", model: "composer-2" }
  }
}

export const resolveModelRoute = (options: {
  readonly profile: RuntimeProfile
  readonly role: TaskRole
  readonly providerOverride?: Provider
  readonly modelOverride?: string
}) => {
  const base = profileTable[options.profile][options.role]

  return {
    provider: options.providerOverride ?? base.provider,
    model: options.modelOverride ?? base.model
  } satisfies ModelRoute
}
