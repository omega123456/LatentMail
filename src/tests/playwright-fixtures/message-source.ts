import type { IpcCommandMap } from '@/lib/types/ipc';

const playwrightRawSourceHeaders = [
  'Delivered-To: you@example.com',
  'Received: from mail.ethereal.example.com (mail.ethereal.example.com. [203.0.113.24])',
  '        by mx.google.com with ESMTPS id a1-20020a05;',
  '        Tue, 11 Aug 2026 02:00:07 -0700 (PDT)',
  'Authentication-Results: mx.google.com;',
  '       dkim=pass header.i=@ethereal.example.com;',
  '       spf=pass (google.com: domain of elena.r@example.com designates 203.0.113.24 as permitted sender);',
  '       dmarc=pass (p=REJECT sp=REJECT dis=NONE)',
  'From: Elena Rodriguez <elena.r@example.com>',
  'To: You <you@example.com>, David <david@example.com>, Sarah <sarah@example.com>',
  'Subject: Q3 Marketing Strategy Review',
  'Date: Tue, 11 Aug 2026 09:00:05 +0000',
  'Message-ID: <q3-review.7f3a9c@mail.ethereal.example.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="eth_b1"',
  '',
  '--eth_b1',
  'Content-Type: text/html; charset="UTF-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<p>Hi Team,</p><p>I&#39;ve attached the finalized slide deck for tomorrow&#39;s Q3 =',
  'Marketing Strategy presentation.</p>',
  '--eth_b1',
  'Content-Type: application/pdf; name="Q3-summary.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
];

const playwrightEncodedBody = Array.from(
  { length: 12 },
  () => 'JVBERi0xLjcKJcfsj6IKNSAwIG9iago8PC9MZW5ndGggNiAwIFIvRmlsdGVyIC9GbGF0ZURlY29kZT4+',
);

export const playwrightMessageSource: IpcCommandMap['read_message_source']['result'] = {
  messageId: '<q3-review.7f3a9c@mail.ethereal.example.com>',
  sentAt: Date.parse('2026-08-11T09:00:00Z'),
  sender: 'Elena Rodriguez <elena.r@example.com>',
  to: 'You <you@example.com>, David <david@example.com>, Sarah <sarah@example.com>',
  cc: '',
  subject: 'Q3 Marketing Strategy Review',
  authenticationResults:
    'mx.google.com; dkim=pass header.i=@ethereal.example.com; spf=pass (google.com: domain of elena.r@example.com designates 203.0.113.24 as permitted sender); dmarc=pass (p=REJECT sp=REJECT dis=NONE)',
  sizeBytes: 1468920,
  raw: [...playwrightRawSourceHeaders, ...playwrightEncodedBody, '--eth_b1--', ''].join('\r\n'),
  display: [
    ...playwrightRawSourceHeaders,
    '[Q3-summary.pdf · 1.4 MB of base64 hidden · Copy and Download include it]',
    '--eth_b1--',
    '',
  ].join('\n'),
};
