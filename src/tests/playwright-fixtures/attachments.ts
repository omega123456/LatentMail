import type { IpcCommandMap } from '@/lib/types/ipc';

export const playwrightMessageAttachments: IpcCommandMap['load_conversation']['result']['messages'][number]['attachments'] =
  [
    {
      id: 'attachment-1',
      filename: 'Q3-summary.pdf',
      mimeType: 'application/pdf',
      size: 1468006,
      position: 0,
    },
    {
      id: 'attachment-2',
      filename: 'close-workbook.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 325632,
      position: 1,
    },
    {
      id: 'attachment-3',
      filename: 'scan-0142.jpg',
      mimeType: 'image/jpeg',
      size: 2202009,
      position: 2,
    },
  ];

export const playwrightCachedAttachment: IpcCommandMap['ensure_attachment_cached']['result'] = {
  cachePath: '/attachment-cache/account-1/message-2/attachment-3',
  displayPath: '/attachment-cache/account-1/message-2/attachment-3',
  mimeType: 'image/jpeg',
  filename: 'scan-0142.jpg',
  size: 2202009,
};

export const playwrightAttachmentImageSrc =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='480'%3E%3Crect width='640' height='480' fill='%23e4e7ee'/%3E%3Crect x='40' y='40' width='560' height='400' fill='%23ffffff' stroke='%23c1c6d7' stroke-width='4'/%3E%3Ccircle cx='180' cy='180' r='60' fill='%23f2c14e'/%3E%3Cpath d='M60 380 220 220 340 340 460 200 580 380Z' fill='%237ba8d1'/%3E%3C/svg%3E";
