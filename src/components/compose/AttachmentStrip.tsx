import type { ComposeAttachment } from '@/stores/compose';
import { AttachmentChip } from './AttachmentChip';

/** Sits between the body and the footer, above the footer hairline
 * (wireframe "Attachment chips — settled, reading, failed"). Renders only
 * ordinary attachments — a `ComposeAttachment` carrying a `contentId` is an
 * inline image already inserted at the caret, not a chip. */
export function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: ComposeAttachment[];
  onRemove: (localId: string) => void;
}) {
  const chips = attachments.filter((attachment) => attachment.contentId === null);
  if (chips.length === 0) return null;
  return (
    <div
      data-testid="attachment-strip"
      className="mx-stack-gap-md flex flex-wrap gap-stack-gap-sm border-t border-outline-variant py-3 dark:border-dark-outline-variant"
    >
      {chips.map((attachment) => (
        <AttachmentChip
          key={attachment.localId}
          attachment={attachment}
          onRemove={() => onRemove(attachment.localId)}
        />
      ))}
    </div>
  );
}
