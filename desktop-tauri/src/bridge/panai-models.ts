export type PanAiModelFamily = 'gpt' | 'claude' | 'deepseek' | 'kimi' | 'agnes'

export interface PanAiModelOption {
  id: string
  family: PanAiModelFamily
  label: string
  model: string
  agent: 'codex' | 'claude' | 'kimi'
  providerId?: string
}

interface ProviderWire {
  id?: unknown
  platform?: unknown
  name?: unknown
  base_url?: unknown
  models?: unknown
  enabled?: unknown
  model_enabled?: unknown
  model_health?: unknown
}

interface Envelope {
  success?: unknown
  data?: unknown
}

export interface PanAiModelCatalogDeps {
  fetch: typeof fetch
  hosted: boolean
}

export const PANAI_MODEL_KEY = 'panoffice.panai.model'
export const PANAI_MODEL_CHANGE_EVENT = 'panoffice-panai-model-change'
export const KIMI_CODING_BASE_URL = 'https://api.kimi.com/coding/v1'

const AGENT_MODELS: readonly PanAiModelOption[] = [
  {
    id: 'agent:codex:gpt-5.6-sol',
    family: 'gpt',
    label: 'GPT · 5.6 Sol',
    model: 'gpt-5.6-sol',
    agent: 'codex',
  },
  {
    id: 'agent:claude:claude-sonnet-5-xhigh',
    family: 'claude',
    label: 'Claude · Sonnet 5',
    model: 'claude-sonnet-5-xhigh',
    agent: 'claude',
  },
]

const familyAgent: Record<PanAiModelFamily, PanAiModelOption['agent']> = {
  gpt: 'codex',
  claude: 'claude',
  deepseek: 'codex',
  kimi: 'kimi',
  agnes: 'codex',
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeUrl(value: unknown): string {
  return text(value).replace(/\/+$/, '')
}

function providerFamily(provider: ProviderWire): PanAiModelFamily | null {
  const hint = `${text(provider.platform)} ${text(provider.name)} ${normalizeUrl(provider.base_url)}`.toLowerCase()
  if (hint.includes('deepseek')) return 'deepseek'
  if (hint.includes('kimi') || hint.includes('moonshot')) return 'kimi'
  if (hint.includes('agnes')) return 'agnes'
  if (hint.includes('anthropic') || hint.includes('claude')) return 'claude'
  if (hint.includes('openai') || hint.includes('gpt')) return 'gpt'
  return null
}

function isModelEnabled(provider: ProviderWire, model: string): boolean {
  const enabled = provider.model_enabled
  if (enabled && typeof enabled === 'object' && !Array.isArray(enabled)) {
    if ((enabled as Record<string, unknown>)[model] === false) return false
  }
  const health = provider.model_health
  if (health && typeof health === 'object' && !Array.isArray(health)) {
    const entry = (health as Record<string, unknown>)[model]
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      if ((entry as Record<string, unknown>).status === 'unhealthy') return false
    }
  }
  return true
}

function isTextModel(family: PanAiModelFamily, model: string): boolean {
  if (family !== 'agnes') return true
  return !/(?:image|video|embedding|rerank)/i.test(model)
}

export function optionsFromProviders(payload: unknown): PanAiModelOption[] {
  const envelope = payload as Envelope
  if (envelope?.success !== true || !Array.isArray(envelope.data)) return []
  const options: PanAiModelOption[] = []
  for (const raw of envelope.data) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const provider = raw as ProviderWire
    const providerId = text(provider.id)
    const family = providerFamily(provider)
    if (!providerId || !family || provider.enabled === false || !Array.isArray(provider.models)) continue
    if (family === 'kimi' && normalizeUrl(provider.base_url) !== KIMI_CODING_BASE_URL) continue
    for (const rawModel of provider.models) {
      const model = text(rawModel)
      if (!model || !isModelEnabled(provider, model) || !isTextModel(family, model)) continue
      options.push({
        id: `provider:${providerId}:${model}`,
        family,
        label: `${family === 'gpt' ? 'GPT' : family === 'claude' ? 'Claude' : family === 'deepseek' ? 'DeepSeek' : family === 'kimi' ? 'Kimi' : 'Agnes'} · ${model}`,
        model,
        agent: familyAgent[family],
        providerId,
      })
    }
  }
  return options
}

function dedupe(options: readonly PanAiModelOption[]): PanAiModelOption[] {
  return [...new Map(options.map((option) => [option.id, option])).values()]
}

function standaloneOption(model: string): PanAiModelOption {
  const claude = model.toLowerCase().includes('claude')
  return {
    id: `agent:${claude ? 'claude' : 'codex'}:${model}`,
    family: claude ? 'claude' : 'gpt',
    label: `${claude ? 'Claude' : 'GPT'} · ${model}`,
    model,
    agent: claude ? 'claude' : 'codex',
  }
}

export async function loadPanAiModelCatalog(deps: PanAiModelCatalogDeps): Promise<PanAiModelOption[]> {
  try {
    const response = await deps.fetch(deps.hosted ? '/api/providers' : '/panai/config', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    })
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      return [...AGENT_MODELS]
    }
    const payload = await response.json()
    if (!deps.hosted) {
      const config = payload as { enabled?: unknown; model?: unknown }
      const model = text(config.model)
      return config.enabled === true && model ? [standaloneOption(model)] : [...AGENT_MODELS]
    }
    return dedupe([...AGENT_MODELS, ...optionsFromProviders(payload)])
  } catch {
    return [...AGENT_MODELS]
  }
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function selectedPanAiModel(options: readonly PanAiModelOption[]): PanAiModelOption {
  const selected = storage()?.getItem(PANAI_MODEL_KEY) ?? ''
  return options.find((option) => option.id === selected) ?? options[0] ?? AGENT_MODELS[0]
}

export function setSelectedPanAiModel(id: string): void {
  storage()?.setItem(PANAI_MODEL_KEY, id)
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PANAI_MODEL_CHANGE_EVENT, { detail: id }))
}

const browserCatalog = new Map<boolean, Promise<PanAiModelOption[]>>()

export function loadBrowserPanAiModelCatalog(hosted: boolean): Promise<PanAiModelOption[]> {
  const cached = browserCatalog.get(hosted)
  if (cached) return cached
  const pending = loadPanAiModelCatalog({ fetch: window.fetch.bind(window), hosted })
  browserCatalog.set(hosted, pending)
  return pending
}

export async function resolveBrowserPanAiModel(hosted: boolean): Promise<PanAiModelOption> {
  return selectedPanAiModel(await loadBrowserPanAiModelCatalog(hosted))
}
