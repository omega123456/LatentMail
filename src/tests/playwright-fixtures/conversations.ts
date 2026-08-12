import type { IpcCommandMap } from '@/lib/types/ipc';

export const playwrightConversation: IpcCommandMap['load_conversation']['result'] = {
  threadId: 'thread-1',
  subject: 'Q3 Marketing Strategy Review',
  messages: [
    {
      id: 'message-1',
      sender: 'Elena Rodriguez <elena.r@example.com>',
      recipients: ['You <you@example.com>', 'Alex <alex@example.com>', 'Sam <sam@example.com>'],
      subject: 'Q3 Marketing Strategy Review',
      sentAt: Date.parse('2026-08-10T09:00:00Z'),
      snippet: "I've attached the finalized slides for tomorrow's presentation.",
      htmlBody: "<p>I've attached the finalized slides for tomorrow's presentation.</p>",
      htmlPresence: 'present',
      plainBody: null,
      hasAttachments: false,
      isUnread: false,
      isStarred: false,
      labelIds: [],
      remoteImagesBlocked: false,
    },
    {
      id: 'message-2',
      sender: 'Elena Rodriguez <elena.r@example.com>',
      recipients: [
        'You <you@example.com>',
        'David <david@example.com>',
        'Sarah <sarah@example.com>',
      ],
      subject: 'Q3 Marketing Strategy Review',
      sentAt: Date.parse('2026-08-11T09:00:00Z'),
      snippet:
        "I've attached the finalized slide deck for tomorrow's Q3 Marketing Strategy presentation.",
      htmlBody:
        "<p>Hi Team,</p><p>I hope you're all having a great week.</p><p>I've attached the finalized slide deck for tomorrow's Q3 Marketing Strategy presentation. I've incorporated the feedback from last Thursday's sync, specifically around our digital spend allocation and the revised timeline for the social campaign launch.</p><p><strong>Please pay special attention to:</strong></p><ul><li>Slide 12: Budget reallocation from traditional to digital channels.</li><li>Slide 15: The revised KPI targets for Q3 (we bumped up the conversion goal by 5%).</li><li>Slide 20: The updated creative assets preview.</li></ul><p>Let me know if you spot any glaring errors or if we need to adjust the narrative flow before we present to the executive board. I'll be online for the next few hours to make any final tweaks.</p><p>Best regards,</p><p><strong>Elena Rodriguez</strong><br>Director of Marketing | Ethereal Corp<br>elena.r@ethereal.example.com</p>",
      htmlPresence: 'present',
      plainBody: null,
      hasAttachments: false,
      isUnread: true,
      isStarred: false,
      labelIds: ['Label_1'],
      remoteImagesBlocked: true,
    },
  ],
};

export const playwrightDeferredBodyConversation: IpcCommandMap['load_conversation']['result'] = {
  ...playwrightConversation,
  messages: playwrightConversation.messages.map((message, index) =>
    index === playwrightConversation.messages.length - 1
      ? { ...message, htmlBody: null, htmlPresence: 'neverFetched' as const }
      : message,
  ),
};
