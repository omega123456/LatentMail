import { parseISO } from 'date-fns';
import type { ReaderConversation } from './reading-pane-helpers';

export const readerFixtures: Record<string, ReaderConversation> = {
  'thread-1': {
    id: 'thread-1',
    subject: 'Q3 Marketing Strategy Review',
    messages: [
      {
        id: 'message-1',
        sender: { name: 'Elena Rodriguez', address: 'elena.r@example.com' },
        recipients: [
          { name: 'You', address: 'you@example.com' },
          { name: 'Alex', address: 'alex@example.com' },
          { name: 'Sam', address: 'sam@example.com' },
        ],
        sentAt: parseISO('2026-08-10T09:00:00Z'),
        snippet: "I've attached the finalized slides for tomorrow's presentation.",
        html: "<p>I've attached the finalized slides for tomorrow's presentation.</p>",
        text: null,
      },
      {
        id: 'message-2',
        sender: { name: 'Elena Rodriguez', address: 'elena.r@example.com' },
        recipients: [
          { name: 'You', address: 'you@example.com' },
          { name: 'David', address: 'david@example.com' },
          { name: 'Sarah', address: 'sarah@example.com' },
        ],
        sentAt: parseISO('2026-08-11T09:00:00Z'),
        snippet:
          "I've attached the finalized slide deck for tomorrow's Q3 Marketing Strategy presentation.",
        html: "<p>Hi Team,</p><p>I hope you're all having a great week.</p><p>I've attached the finalized slide deck for tomorrow's Q3 Marketing Strategy presentation. I've incorporated the feedback from last Thursday's sync, specifically around our digital spend allocation and the revised timeline for the social campaign launch.</p><p><strong>Please pay special attention to:</strong></p><ul><li>Slide 12: Budget reallocation from traditional to digital channels.</li><li>Slide 15: The revised KPI targets for Q3 (we bumped up the conversion goal by 5%).</li><li>Slide 20: The updated creative assets preview.</li></ul><p>Let me know if you spot any glaring errors or if we need to adjust the narrative flow before we present to the executive board. I'll be online for the next few hours to make any final tweaks.</p><p>Best regards,</p><p><strong>Elena Rodriguez</strong><br>Director of Marketing | Ethereal Corp<br>elena.r@ethereal.example.com</p>",
        text: null,
        labelIds: ['INBOX'],
        remoteImagesBlocked: true,
      },
    ],
  },
};
