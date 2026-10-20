import { describe, expect, it } from 'vitest';
import { describeModel } from './model-names';

describe('describeModel', () => {
  it('splits vendor, readable name and tags of OpenRouter ids', () => {
    expect(describeModel('~anthropic/claude-opus-latest')).toEqual({
      id: '~anthropic/claude-opus-latest',
      name: 'Claude Opus',
      vendor: 'Anthropic',
      tags: ['neueste Version'],
    });
    expect(describeModel('deepseek/deepseek-v4.1-flash:free')).toMatchObject({ name: 'DeepSeek V4.1 Flash', vendor: 'DeepSeek', tags: ['kostenlos'] });
    expect(describeModel('meta-llama/llama-3.3-70b-instruct')).toMatchObject({ name: 'Llama 3.3 70B Instruct', vendor: 'Meta' });
    expect(describeModel('openai/gpt-5.1-codex')).toMatchObject({ name: 'GPT-5.1 Codex', vendor: 'OpenAI' });
    expect(describeModel('x-ai/grok-4')).toMatchObject({ name: 'Grok 4', vendor: 'xAI' });
    expect(describeModel('some-lab/cool-model')).toMatchObject({ name: 'Cool Model', vendor: 'Some Lab' });
  });

  it('joins dashed version numbers and turns dates into tags', () => {
    expect(describeModel('claude-opus-4-1-20250805')).toEqual({ id: 'claude-opus-4-1-20250805', name: 'Claude Opus 4.1', vendor: null, tags: ['2025-08-05'] });
    expect(describeModel('gpt-4o-2024-08-06')).toMatchObject({ name: 'GPT-4o', tags: ['2024-08-06'] });
    expect(describeModel('qwen3-coder:30b')).toMatchObject({ name: 'Qwen3 Coder', tags: ['30b'] });
  });

  it('falls back to the raw id', () => {
    expect(describeModel('latest').name).toBe('latest');
  });
});
