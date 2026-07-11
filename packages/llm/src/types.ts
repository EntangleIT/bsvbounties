export type LlmProvider = 'xai' | 'openai' | 'anthropic' | 'mock'

export interface LlmConfig {
  provider: LlmProvider
  model: string
  apiKey?: string
  /** Override base URL (e.g. custom proxy) */
  baseUrl?: string
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmChatRequest {
  messages: LlmMessage[]
  temperature?: number
  maxTokens?: number
}

export interface LlmChatResponse {
  content: string
  provider: LlmProvider
  model: string
  usage?: { promptTokens?: number; completionTokens?: number }
}

export interface LlmClient {
  readonly config: LlmConfig
  chat(req: LlmChatRequest): Promise<LlmChatResponse>
}
