import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { subscribeToFileDrop } from '@/lib/compose/file-drop';
import {
  generateInlineContentId,
  guessMimeType,
  pickAttachments,
  pickImages,
  stageAttachmentPath,
} from '@/lib/compose/staging';
import { invoke } from '@/lib/ipc/commands';
import { useComposeStore } from '@/stores/compose';
import type { BodyEditorHandle } from './BodyEditor';

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function useAttachmentPipeline(bodyRef: RefObject<BodyEditorHandle | null>) {
  const session = useComposeStore((state) => state.session);
  const addReadingAttachment = useComposeStore((state) => state.addReadingAttachment);
  const settleAttachment = useComposeStore((state) => state.settleAttachment);
  const failAttachment = useComposeStore((state) => state.failAttachment);
  const removeAttachment = useComposeStore((state) => state.removeAttachment);

  const accountId = session?.accountId ?? '';
  const owner = session?.draftId ?? session?.id ?? '';
  const stagePathRef = useRef<(path: string, contentId: string | null) => void>(() => undefined);

  const stagePath = useCallback(
    (path: string, contentId: string | null) => {
      const localId = crypto.randomUUID();
      addReadingAttachment({
        localId,
        filename: basename(path),
        mimeType: guessMimeType(path),
        contentId,
      });
      void stageAttachmentPath(accountId, owner, path, contentId)
        .then((staged) => {
          settleAttachment(localId, {
            id: staged.id,
            path: staged.path,
            assetUrl: staged.assetUrl,
            size: staged.size,
          });
          if (contentId) bodyRef.current?.insertInlineImage(staged.assetUrl);
        })
        .catch((error: unknown) => {
          failAttachment(localId, error instanceof Error ? error.message : "Couldn't read");
        });
    },
    [accountId, owner, addReadingAttachment, settleAttachment, failAttachment, bodyRef],
  );
  stagePathRef.current = stagePath;

  const onAttach = useCallback(async () => {
    const paths = await pickAttachments();
    paths.forEach((path) => stagePath(path, null));
  }, [stagePath]);

  const onInsertImage = useCallback(async () => {
    const paths = await pickImages();
    paths.forEach((path) => stagePath(path, generateInlineContentId()));
  }, [stagePath]);

  const onRemoveAttachment = useCallback(
    (localId: string) => {
      const attachment = session?.attachments.find((entry) => entry.localId === localId);
      removeAttachment(localId);
      if (attachment?.staged) {
        void invoke('release_staged_attachment', { accountId, owner, id: attachment.staged.id });
      }
    },
    [session?.attachments, removeAttachment, accountId, owner],
  );

  useEffect(() => {
    if (!session) return;
    return subscribeToFileDrop((paths) =>
      paths.forEach((path) => stagePathRef.current(path, null)),
    );
  }, [session?.id]);

  const previousHtml = useRef(session?.html ?? '');
  useEffect(() => {
    const html = session?.html ?? '';
    if (html === previousHtml.current) return;
    const removedInlineImages = (session?.attachments ?? []).filter(
      (attachment) =>
        attachment.contentId &&
        attachment.staged &&
        previousHtml.current.includes(attachment.staged.assetUrl) &&
        !html.includes(attachment.staged.assetUrl),
    );
    previousHtml.current = html;
    removedInlineImages.forEach((attachment) => {
      removeAttachment(attachment.localId);
      if (attachment.staged) {
        void invoke('release_staged_attachment', { accountId, owner, id: attachment.staged.id });
      }
    });
  }, [session?.html, session?.attachments, accountId, owner, removeAttachment]);

  return { onAttach, onInsertImage, onRemoveAttachment };
}
