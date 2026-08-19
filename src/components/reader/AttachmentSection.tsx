import { useState } from 'react';
import { Paperclip } from 'lucide-react';
import type { MessageAttachment } from '@/lib/types/ipc';
import { AttachmentPreviewDialog } from './AttachmentPreviewDialog';
import { ReceivedAttachmentChip } from './ReceivedAttachmentChip';

export function AttachmentSection({
  accountId,
  messageId,
  attachments,
}: {
  accountId: string | null;
  messageId: string;
  attachments: MessageAttachment[];
}) {
  const [previewing, setPreviewing] = useState<MessageAttachment | null>(null);
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-col gap-stack-gap-sm" data-testid="attachment-section">
      <div className="flex items-center gap-1.5 text-label-md text-on-surface-variant dark:text-dark-on-surface-variant">
        <Paperclip size={14} aria-hidden="true" />
        <span>
          {attachments.length} {attachments.length === 1 ? 'attachment' : 'attachments'}
        </span>
      </div>
      <div className="flex flex-wrap gap-stack-gap-sm">
        {attachments.map((attachment) => (
          <ReceivedAttachmentChip
            key={attachment.id}
            accountId={accountId}
            messageId={messageId}
            attachment={attachment}
            onPreview={() => setPreviewing(attachment)}
          />
        ))}
      </div>
      {previewing && (
        <AttachmentPreviewDialog
          accountId={accountId}
          messageId={messageId}
          attachment={previewing}
          onClose={() => setPreviewing(null)}
        />
      )}
    </div>
  );
}
