import type { IpcCommandMap } from '@/lib/types/ipc';
import type { OpenComposeArgs } from '@/stores/compose';

export const playwrightContactSuggestions = [] satisfies IpcCommandMap['lookup_contacts']['result'];

export const playwrightContactSuggestionMatches = [
  { address: 'marta.oliveira@example.com', displayName: 'Marta Oliveira' },
  { address: 'm.bell@partner.io', displayName: 'Marcus Bell' },
  { address: 'marketing@example.com', displayName: null },
] satisfies IpcCommandMap['lookup_contacts']['result'];

export const playwrightStagedAttachment = {
  id: 'staged-1',
  filename: 'attachment.txt',
  mimeType: 'text/plain',
  path: '/staged/attachment.txt',
  contentId: null,
  size: 2048,
} satisfies IpcCommandMap['stage_attachment_from_path']['result'];

export const playwrightReplyContext: IpcCommandMap['reply_context']['result'] = {
  to: [],
  cc: [],
  subject: '',
  originalMessageId: '',
  targetThreadId: null,
  inReplyTo: null,
  references: [],
  originalGmailMessageId: '',
  displayQuote: null,
  attachments: [],
};

export const playwrightSavedDraftAcceptance: IpcCommandMap['save_compose_draft']['result'] = {
  operationId: 'draft-operation',
  draftId: 'draft-1',
};

export const playwrightSentDraftAcceptance: IpcCommandMap['send_compose_draft']['result'] = {
  operationId: 'send-operation',
  draftId: 'draft-1',
};

export const playwrightHydratedDraft: IpcCommandMap['hydrate_compose_draft']['result'] = {
  sessionId: 'session-1',
  accountId: 'account-1',
  draftId: 'draft-1',
  from: 'alex@example.com',
  to: [],
  cc: [],
  bcc: [],
  subject: '',
  html: '',
  quoteHtml: null,
  quotePlain: null,
  mode: 'draft',
  threadId: null,
  inReplyTo: null,
  references: [],
  originalMessageId: null,
  originalGmailMessageId: null,
  attachments: [],
};

export const playwrightNewComposeSession: OpenComposeArgs = {
  id: 'compose-session-1',
  mode: 'new',
  accountId: 'mail-account',
  from: 'you@example.com',
  recipients: { to: [], cc: [], bcc: [] },
  subject: '',
  html: '',
};

export const playwrightStagedImageUrlPattern = 'http://asset.localhost/**';

export const playwrightStagedImageSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="72"><rect width="120" height="72" fill="#dce8ff"/><path d="M12 54 40 34l20 12 42-30" fill="none" stroke="#1459c7" stroke-width="5"/></svg>';

export const playwrightAttachmentsComposeSession: OpenComposeArgs = {
  id: 'compose-session-attachments',
  mode: 'new',
  accountId: 'mail-account',
  from: 'you@example.com',
  recipients: { to: ['elena.r@example.com'], cc: [], bcc: [] },
  subject: 'Q3 budget',
  html: '<p>See the chart:</p><img src="http://asset.localhost/compose-staging/chart.png" alt="Budget chart">',
  attachments: [
    {
      localId: 'budget-pdf',
      filename: 'Q3-budget.pdf',
      mimeType: 'application/pdf',
      size: 253952,
      state: 'settled',
      staged: {
        id: 'staged-budget-pdf',
        path: '/compose-staging/Q3-budget.pdf',
        assetUrl: 'http://asset.localhost/compose-staging/Q3-budget.pdf',
        size: 253952,
      },
      contentId: null,
      error: null,
    },
    {
      localId: 'chart-image',
      filename: 'chart.png',
      mimeType: 'image/png',
      size: 1024,
      state: 'settled',
      staged: {
        id: 'staged-chart-image',
        path: '/compose-staging/chart.png',
        assetUrl: 'http://asset.localhost/compose-staging/chart.png',
        size: 1024,
      },
      contentId: 'cid:chart@latentmail',
      error: null,
    },
  ],
};

export const playwrightManyRecipientsComposeSession: OpenComposeArgs = {
  id: 'compose-session-2',
  mode: 'new',
  accountId: 'mail-account',
  from: 'you@example.com',
  recipients: {
    to: [
      'Priya Raman <priya.raman@example.com>',
      'Tomás Field <tomas.field@example.com>',
      'ops@example.com',
      'marketing@example.com',
      'engineering@example.com',
      'design@example.com',
      'finance.team@example.com',
      'customer.success@example.com',
      'product@example.com',
      'legal@example.com',
    ],
    cc: ['Dana Whitfield <dana.whitfield@example.com>'],
    bcc: [],
  },
  subject: '',
  html: '',
};

export const playwrightSuggestionsComposeSession: OpenComposeArgs = {
  id: 'compose-session-suggestions',
  mode: 'new',
  accountId: 'mail-account',
  from: 'you@example.com',
  recipients: { to: ['Priya Raman <priya.raman@example.com>'], cc: [], bcc: [] },
  subject: '',
  html: '',
};

export const playwrightReplyComposeSession: OpenComposeArgs = {
  id: 'compose-session-3',
  mode: 'reply',
  accountId: 'mail-account',
  from: 'you@example.com',
  recipients: { to: ['elena.r@example.com'], cc: [], bcc: [] },
  subject: 'Re: Q3 Marketing Strategy Review',
  html: '',
  quote: {
    html: "<p>Hi Team, I hope you're all having a great week. I've attached the finalized slide deck for tomorrow's presentation.</p>",
    attribution: 'On 14 Mar 2024 at 10:42, Elena Rodriguez wrote:',
  },
};
