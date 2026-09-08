const {
  PUBLIC_EVENT_STATUSES,
  HUD_EVENT_MAX_LINE_LENGTH,
  appendOrReplaceEventDetailsSuffix,
  buildCompactHudEventRow,
  isTerminalPublicEventStatus,
  mapDiscordEventLifecycle,
  stripExactGeneratedEventDetailsSuffix,
  stableDiscordEventCode,
} = require('../src/services/discordEventProjection');

describe('Discord event lifecycle projection', () => {
  it('generates stable event codes that are scoped to the guild', () => {
    const first = stableDiscordEventCode('guild-a', 'event-1');
    expect(first).toMatch(/^EVT-[A-F0-9]{12}$/);
    expect(stableDiscordEventCode('guild-a', 'event-1')).toBe(first);
    expect(stableDiscordEventCode('guild-b', 'event-1')).not.toBe(first);
    expect(stableDiscordEventCode('guild-a', 'event-2')).not.toBe(first);
  });

  test.each([
    ['SCHEDULED', 'Upcoming', false],
    ['ACTIVE', 'Live', false],
    ['COMPLETED', 'Ended', true],
    ['CANCELED', 'Canceled', true],
    ['DELETED', 'Deleted', true],
  ])('maps %s to %s with terminal=%s', (sourceState, status, isTerminal) => {
    expect(mapDiscordEventLifecycle(sourceState)).toEqual({
      status,
      isTerminal,
    });
  });

  test.each([
    ['Upcoming', false],
    ['Live', false],
    ['Ended', true],
    ['Canceled', true],
    ['Deleted', true],
  ])('reports %s terminal=%s', (status, expected) => {
    expect(isTerminalPublicEventStatus(status)).toBe(expected);
  });

  it('exposes every public status used by the projection', () => {
    expect(Object.values(PUBLIC_EVENT_STATUSES)).toEqual([
      'Upcoming',
      'Live',
      'Ended',
      'Canceled',
      'Deleted',
    ]);
  });
});

describe('Discord event description suffix', () => {
  const eventCode = 'EVT-42';
  const messageUrl = 'https://discord.com/channels/1/2/3';

  it('preserves creator text exactly when appending the suffix', () => {
    const creatorDescription = 'Bring your own gear.\nSecond line  ';

    expect(
      appendOrReplaceEventDetailsSuffix(
        creatorDescription,
        eventCode,
        messageUrl,
      ),
    ).toBe(
      creatorDescription
        + '\n\nFCM event details [EVT-42]: https://discord.com/channels/1/2/3',
    );
  });

  it('is idempotent and never duplicates its generated suffix', () => {
    const first = appendOrReplaceEventDetailsSuffix(
      'Creator text',
      eventCode,
      messageUrl,
    );

    expect(
      appendOrReplaceEventDetailsSuffix(first, eventCode, messageUrl),
    ).toBe(first);
    expect(first.match(/FCM event details/g)).toHaveLength(1);
  });

  it('replaces only the explicitly supplied previous generated suffix', () => {
    const creatorText =
      'Creator text\nwith a [bracket] and a URL https://example.test';
    const previousGeneratedSuffix =
      'FCM event details [OLD-CODE]: https://discord.com/channels/1/2/old';
    const original = creatorText + '\n\n' + previousGeneratedSuffix;

    expect(
      appendOrReplaceEventDetailsSuffix(
        original,
        'NEW-CODE',
        'https://discord.com/channels/1/2/new',
        previousGeneratedSuffix,
      ),
    ).toBe(
      creatorText
        + '\n\nFCM event details [NEW-CODE]: https://discord.com/channels/1/2/new',
    );
  });

  it('preserves suffix-looking creator text without prior generated state', () => {
    const creatorDescription =
      'Creator text\n\nFCM event details [CREATOR]: https://example.test/details';

    expect(
      appendOrReplaceEventDetailsSuffix(
        creatorDescription,
        eventCode,
        messageUrl,
      ),
    ).toBe(
      creatorDescription
        + '\n\nFCM event details [EVT-42]: https://discord.com/channels/1/2/3',
    );
  });

  it('strips an exact stored suffix and leaves a different suffix untouched', () => {
    const creatorText = 'Creator text';
    const previousGeneratedSuffix =
      'FCM event details [OLD-CODE]: https://discord.com/channels/1/2/old';
    const description = creatorText + '\n\n' + previousGeneratedSuffix;

    expect(
      stripExactGeneratedEventDetailsSuffix(
        description,
        previousGeneratedSuffix,
      ),
    ).toBe(creatorText);
    expect(
      stripExactGeneratedEventDetailsSuffix(
        description,
        'FCM event details [OTHER]: https://discord.com/channels/1/2/other',
      ),
    ).toBe(description);
  });

  it('does not append a placeholder or invalid URL', () => {
    const creatorDescription = 'Creator text';

    expect(
      appendOrReplaceEventDetailsSuffix(
        creatorDescription,
        eventCode,
        '<announcement-message-url>',
      ),
    ).toBe(creatorDescription);

    expect(
      appendOrReplaceEventDetailsSuffix(creatorDescription, eventCode, ''),
    ).toBe(creatorDescription);
  });

  it('keeps an existing valid suffix when a replacement URL is invalid', () => {
    const existing = appendOrReplaceEventDetailsSuffix(
      'Creator text',
      eventCode,
      messageUrl,
    );

    expect(
      appendOrReplaceEventDetailsSuffix(
        existing,
        'NEW-CODE',
        'not-a-real-url',
      ),
    ).toBe(existing);
  });

  it('returns the original creator description when the generated suffix overflows', () => {
    const creatorDescription = 'Creator text';
    const expectedWithoutLimit = appendOrReplaceEventDetailsSuffix(
      creatorDescription,
      eventCode,
      messageUrl,
    );

    expect(
      appendOrReplaceEventDetailsSuffix(
        creatorDescription,
        eventCode,
        messageUrl,
        undefined,
        expectedWithoutLimit.length - 1,
      ),
    ).toBe(creatorDescription);
  });

  it('accepts the generated description at the exact maximum length', () => {
    const creatorDescription = 'Creator text';
    const expected = appendOrReplaceEventDetailsSuffix(
      creatorDescription,
      eventCode,
      messageUrl,
    );

    expect(
      appendOrReplaceEventDetailsSuffix(
        creatorDescription,
        eventCode,
        messageUrl,
        undefined,
        expected.length,
      ),
    ).toBe(expected);
  });

  it('returns creator text on overflow after removing an explicit prior suffix', () => {
    const creatorDescription = 'Creator text';
    const previousGeneratedSuffix =
      'FCM event details [OLD-CODE]: https://discord.com/channels/1/2/old';
    const description = creatorDescription + '\n\n' + previousGeneratedSuffix;

    expect(
      appendOrReplaceEventDetailsSuffix(
        description,
        eventCode,
        messageUrl,
        previousGeneratedSuffix,
        10,
      ),
    ).toBe(creatorDescription);
  });
});

describe('compact HUD event row', () => {
  it('formats an upcoming event with UTC time and Interested count', () => {
    expect(
      buildCompactHudEventRow({
        name: 'Moonshine Jamboree',
        status: 'Upcoming',
        startUtc: '2026-09-08T20:00:00.000Z',
        interestedCount: 6,
      }),
    ).toBe(
      '[EVENTS] [EVENT] FCM: Moonshine Jamboree | 20:00 UTC | 6 interested',
    );
  });

  it('includes an escaped event code when it fits', () => {
    expect(
      buildCompactHudEventRow({
        name: 'Event',
        eventCode: 'EVT|42',
        status: 'Live',
        interestedCount: 6,
      }),
    ).toBe(
      '[EVENTS] [EVENT] FCM: Event [EVT¦42] | LIVE | 6 interested',
    );
  });

  it('includes a code at the exact line boundary and falls back when it cannot fit', () => {
    const exactBoundaryCode = 'X'.repeat(18);
    const exactBoundaryRow = buildCompactHudEventRow({
      name: 'Event',
      eventCode: exactBoundaryCode,
      status: 'Live',
      interestedCount: 6,
    });
    expect(exactBoundaryRow.length).toBe(HUD_EVENT_MAX_LINE_LENGTH);
    expect(exactBoundaryRow).toContain(
      'Event [' + exactBoundaryCode + '] | LIVE | 6 interested',
    );

    const baseInput = {
      name: 'Event',
      status: 'Live',
      interestedCount: 6,
    };
    const withoutEventCode = buildCompactHudEventRow(baseInput);
    const tooLongCodeRow = buildCompactHudEventRow({
      ...baseInput,
      eventCode: 'X'.repeat(24),
    });
    expect(tooLongCodeRow).toBe(withoutEventCode);
  });

  test.each([
    ['Live', 'LIVE'],
    ['Ended', 'ENDED'],
    ['Canceled', 'CANCELED'],
    ['Deleted', 'DELETED'],
  ])('formats the %s public status', (status, statusText) => {
    const row = buildCompactHudEventRow({
      name: 'Event',
      status,
      interestedCount: 6,
    });

    expect(row).toContain(' | ' + statusText + ' | 6 interested');
  });

  it('escapes FCMHUD/1 delimiters and unsafe HUD text characters', () => {
    const row = buildCompactHudEventRow({
      name: '"\\|~<>&\n',
      status: 'Live',
      interestedCount: 2,
    });

    expect(row).toContain(
      '‘/¦∼‹›+ ',
    );
    const nameSegment = row
      .replace('[EVENTS] [EVENT] FCM: ', '')
      .split(' | LIVE | ')[0];
    expect(nameSegment).not.toMatch(/["\\|~<>&\r\n]/);
  });

  it('truncates only the name first and preserves status/time/count', () => {
    const row = buildCompactHudEventRow({
      name: 'A'.repeat(200),
      status: 'Upcoming',
      startUtc: '2026-09-08T20:00:00.000Z',
      interestedCount: 12,
    });

    expect(row.length).toBe(HUD_EVENT_MAX_LINE_LENGTH);
    expect(row).toContain(' | 20:00 UTC | 12 interested');
    expect(row).toMatch(/\.\.\. \| 20:00 UTC \| 12 interested$/);
  });

  it('falls back to an explicit upcoming label for an invalid start time', () => {
    expect(
      buildCompactHudEventRow({
        name: 'Event',
        status: 'Upcoming',
        startUtc: 'not-a-date',
        interestedCount: 0,
      }),
    ).toContain(' | UPCOMING | 0 interested');
  });
});
