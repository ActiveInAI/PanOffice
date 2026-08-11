import { describe, expect, it } from 'vitest'
import {
  KIMI_CODING_BASE_URL,
  loadPanAiModelCatalog,
  optionsFromProviders,
} from '../src/bridge/panai-models'

describe('PanAI model catalog', () => {
  it('projects only enabled text models and never returns provider credentials', () => {
    const options = optionsFromProviders({
      success: true,
      data: [
        {
          id: 'deepseek-id',
          platform: 'deepseek',
          name: 'DeepSeek',
          base_url: 'https://api.deepseek.com/v1',
          api_key: 'masked-secret-that-must-not-leak',
          models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
          enabled: true,
          model_enabled: { 'deepseek-v4-flash': true, 'deepseek-v4-pro': false },
        },
        {
          id: 'agnes-id',
          platform: 'agnes',
          name: 'Agnes AI',
          base_url: 'https://apihub.agnes-ai.com',
          models: ['agnes-2.5-flash', 'agnes-image-2.1-flash', 'agnes-video-v2.0'],
          enabled: true,
        },
      ],
    })

    expect(options.map((option) => option.model)).toEqual(['deepseek-v4-flash', 'agnes-2.5-flash'])
    expect(JSON.stringify(options)).not.toContain('masked-secret')
  })

  it('accepts Kimi only on the required coding endpoint', () => {
    const payload = (base_url: string) => ({
      success: true,
      data: [{ id: 'kimi-id', platform: 'kimi', name: 'Kimi', base_url, models: ['k3'], enabled: true }],
    })
    expect(optionsFromProviders(payload('https://api.moonshot.cn/v1'))).toEqual([])
    expect(optionsFromProviders(payload(`${KIMI_CODING_BASE_URL}/`))).toMatchObject([
      { family: 'kimi', model: 'k3', agent: 'kimi', providerId: 'kimi-id' },
    ])
  })

  it('falls back to server-managed GPT and Claude agents when the provider API fails', async () => {
    const options = await loadPanAiModelCatalog({
      hosted: true,
      fetch: (async () => new Response('offline', { status: 503 })) as typeof fetch,
    })
    expect(options.map((option) => option.family)).toEqual(['gpt', 'claude'])
  })

  it('shows only the model actually forced by the standalone server bridge', async () => {
    const options = await loadPanAiModelCatalog({
      hosted: false,
      fetch: (async () => Response.json({ enabled: true, model: 'gpt-5.6-terra' })) as typeof fetch,
    })
    expect(options).toMatchObject([{ family: 'gpt', model: 'gpt-5.6-terra', agent: 'codex' }])
  })
})
