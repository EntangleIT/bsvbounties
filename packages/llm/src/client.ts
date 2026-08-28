import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmClient,
  LlmConfig,
  LlmProvider,
} from './types.js'

function defaultBaseUrl(provider: LlmProvider): string {
  switch (provider) {
    case 'xai':
      return 'https://api.x.ai/v1'
    case 'openai':
      return 'https://api.openai.com/v1'
    case 'anthropic':
      return 'https://api.anthropic.com/v1'
    default:
      return ''
  }
}

/**
 * OpenAI-compatible chat client (works for xAI Grok + OpenAI).
 * Anthropic uses a thin adapter.
 */
export class ConfigurableLlmClient implements LlmClient {
  readonly config: LlmConfig

  constructor(config: LlmConfig) {
    this.config = config
  }

  async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
    const { provider, model, apiKey } = this.config

    if (provider === 'mock' || !apiKey) {
      return mockChat(req, this.config)
    }

    if (provider === 'anthropic') {
      return anthropicChat(req, this.config)
    }

    // xAI + OpenAI share Chat Completions shape
    const base = this.config.baseUrl ?? defaultBaseUrl(provider)
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: req.messages,
        temperature: req.temperature ?? 0.4,
        max_tokens: req.maxTokens ?? 1024,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`LLM ${provider} error ${res.status}: ${text}`)
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }

    const content = data.choices?.[0]?.message?.content ?? ''
    return {
      content,
      provider,
      model,
      usage: {
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
      },
    }
  }
}

async function anthropicChat(
  req: LlmChatRequest,
  config: LlmConfig,
): Promise<LlmChatResponse> {
  const base = config.baseUrl ?? defaultBaseUrl('anthropic')
  const system = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n')
  const messages = req.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }))

  const res = await fetch(`${base}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: req.maxTokens ?? 1024,
      system: system || undefined,
      messages,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`LLM anthropic error ${res.status}: ${text}`)
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>
  }
  const content =
    data.content?.filter((c) => c.type === 'text').map((c) => c.text).join('') ??
    ''

  return { content, provider: 'anthropic', model: config.model }
}

function mockChat(req: LlmChatRequest, config: LlmConfig): LlmChatResponse {
  const last = [...req.messages].reverse().find((m) => m.role === 'user')
  const text = last?.content ?? ''
  const system = req.messages.find((m) => m.role === 'system')?.content ?? ''

  // Return parseable JSON for draft-bounty prompts
  if (system.includes('Return a concise JSON object')) {
    const ideaMatch = text.match(/Idea:\n([\s\S]*)/)
    const idea = (ideaMatch?.[1] ?? text).trim().slice(0, 200)
    const catMatch = text.match(/Category hint:\s*(\w+)/i)
    const category = catMatch?.[1] ?? 'other'
    const content = JSON.stringify({
      title: idea.slice(0, 72) || 'Untitled bounty',
      description: `Complete the following task and provide verifiable proof of work.\n\n${idea}`,
      category,
      requirements: ['Deliverable linked or hashed', 'Clear acceptance notes'],
    })
    return { content, provider: config.provider, model: config.model }
  }

  if (system.includes('You score a work submission') || system.includes('You are an escrow arbiter')) {
    const fail = /\bFAIL\b/i.test(text) || /\bfraud\b/i.test(text)
    const fraud = /\bfraud\b/i.test(text)
    return {
      content: JSON.stringify({
        pass: !fail,
        score: fail ? 0.2 : 0.85,
        reason: fail ? 'Mock judge: FAIL/fraud token present.' : 'Mock judge: pass.',
        fraud,
      }),
      provider: config.provider,
      model: config.model,
    }
  }

  if (system.includes('Rank open bounties')) {
    let rankedIds: string[] = []
    try {
      const m = text.match(/Bounties:\n([\s\S]*)/)
      const bounties = m?.[1] ? (JSON.parse(m[1]) as Array<{ id: string }>) : []
      rankedIds = bounties.map((b) => b.id)
    } catch {
      rankedIds = []
    }
    return {
      content: JSON.stringify({
        rankedIds,
        notes: 'Mock ranker: identity order. Set XAI_API_KEY for real ranking.',
      }),
      provider: config.provider,
      model: config.model,
    }
  }

  if (system.includes('rank numbered worker')) {
    let rankedNumbers: number[] = []
    try {
      const m = text.match(/Workers:\n([\s\S]*)/)
      const workers = m?.[1] ? (JSON.parse(m[1]) as Array<{ number: number }>) : []
      rankedNumbers = workers.map((w) => w.number)
    } catch {
      rankedNumbers = []
    }
    return {
      content: JSON.stringify({
        rankedNumbers,
        notes: 'Mock worker ranker: identity order.',
      }),
      provider: config.provider,
      model: config.model,
    }
  }

  if (system.includes('rank')) {
    return {
      content: JSON.stringify({
        rankedIds: [],
        notes: 'Mock ranker: set XAI_API_KEY for real ranking.',
      }),
      provider: config.provider,
      model: config.model,
    }
  }

  const snippet = text.slice(0, 120)
  return {
    content: `[mock:${config.provider}/${config.model}] ${snippet}`,
    provider: config.provider,
    model: config.model,
  }
}

export function createLlmFromEnv(
  env: Record<string, string | undefined> = typeof process !== 'undefined'
    ? process.env
    : {},
): LlmClient {
  const provider = (env.LLM_PROVIDER ?? 'xai') as LlmProvider
  const model = env.LLM_MODEL ?? (provider === 'xai' ? 'grok-3' : 'gpt-4o-mini')

  let apiKey: string | undefined
  switch (provider) {
    case 'xai':
      apiKey = env.XAI_API_KEY
      break
    case 'openai':
      apiKey = env.OPENAI_API_KEY
      break
    case 'anthropic':
      apiKey = env.ANTHROPIC_API_KEY
      break
    case 'mock':
      apiKey = undefined
      break
  }

  // No key → mock so local dev always works
  if (!apiKey && provider !== 'mock') {
    return new ConfigurableLlmClient({
      provider: 'mock',
      model: `${provider}:${model}`,
    })
  }

  return new ConfigurableLlmClient({
    provider,
    model,
    apiKey,
    baseUrl: env.LLM_BASE_URL,
  })
}
