import type { RuntimeModel } from '@factorix/runtime'
import { describe, expect, it } from 'vitest'
import { modelVersion, withNewerModels } from './provider-models'

const model = (id: string, efforts: RuntimeModel['efforts'] = ['low', 'high']): RuntimeModel => ({ id, label: id, description: null, efforts })

describe('newer models from the provider', () => {
  it('reads the family and version of Claude and GPT ids', () => {
    expect(modelVersion('claude-fable-5-2')).toEqual({ family: 'fable', version: [5, 2] })
    expect(modelVersion('claude-opus-5')).toEqual({ family: 'opus', version: [5] })
    expect(modelVersion('gpt-6.2-sol')).toEqual({ family: 'sol', version: [6, 2] })
    expect(modelVersion('gpt-5.5')).toEqual({ family: '', version: [5, 5] })
    expect(modelVersion('claude-instant')).toBeNull()
  })

  it('puts the ones newer than the SDK knows of their family first, with that family’s efforts', () => {
    const sdk = [model('gpt-6.1-sol', ['low', 'xhigh']), model('gpt-6-astra', ['medium']), model('gpt-5.5')]
    const listed = [
      { id: 'gpt-6.2-sol', label: 'gpt-6.2-sol' },
      { id: 'gpt-6.2-astra', label: 'gpt-6.2-astra' },
      { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' },
      { id: 'gpt-6-sol', label: 'gpt-6-sol' },
      { id: 'gpt-4.1', label: 'gpt-4.1' },
      { id: 'gpt-7-nova', label: 'gpt-7-nova' },
      { id: 'gpt-6-nova', label: 'gpt-6-nova' },
    ]
    const merged = withNewerModels(sdk, listed)
    expect(merged.map((item) => item.id)).toEqual(['gpt-7-nova', 'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.5'])
    expect(merged.find((item) => item.id === 'gpt-6.2-sol')?.efforts).toEqual(['low', 'xhigh'])
    expect(merged.find((item) => item.id === 'gpt-6.2-astra')?.efforts).toEqual(['medium'])
  })

  it('keeps a Claude family behind the others when it is newer than its own', () => {
    const sdk = [model('claude-opus-5-5'), model('claude-fable-5-1', ['max'])]
    const merged = withNewerModels(sdk, [
      { id: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
      { id: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
    ])
    expect(merged.map((item) => [item.id, item.label])).toEqual([
      ['claude-fable-5-2', 'Claude Fable 5.2'],
      ['claude-opus-5-5', 'claude-opus-5-5'],
      ['claude-fable-5-1', 'claude-fable-5-1'],
    ])
    expect(merged[0]?.efforts).toEqual(['max'])
  })

  it('offers everything the provider lists while the SDK has listed nothing', () => {
    expect(withNewerModels([], [{ id: 'gpt-6.2-sol', label: 'gpt-6.2-sol' }]).map((item) => item.id)).toEqual(['gpt-6.2-sol'])
  })
})
