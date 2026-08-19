import { describe, expect, it } from 'vitest';
import {
  buildTriggerMetadata,
  TRIGGER_LABELS,
  TRIGGER_OPTS,
} from '../features/moderation/AutoModeration';

describe('AutoMod trigger type contract', () => {
  it('exposes AI_MODERATION in the rule editor and display labels', () => {
    expect(TRIGGER_OPTS).toContain('AI_MODERATION');
    expect(TRIGGER_LABELS.AI_MODERATION).toBe('AI Moderation');
  });

  it('preserves targeted-attack policy metadata when saving a preset rule', () => {
    expect(buildTriggerMetadata(
      'KEYWORD_PRESET',
      { presets: ['SLURS'], require_target: true },
      { allowList: '' },
    )).toEqual({
      presets: ['SLURS'],
      require_target: true,
      allow_list: undefined,
    });
  });
});
