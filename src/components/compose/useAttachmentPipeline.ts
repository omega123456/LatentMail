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
import { useComposeStore, type ComposeAttachment, type ComposeSession } from '@/stores/compose';
import type { BodyEditorHandle } from './BodyEditor';

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function resolveAttachmentScope(session: ComposeSession | null) {
  if (!session) return { accountId: '', owner: '' };
  return { accountId: session.accountId, owner: session.draftId ?? session.id };
}

function releaseStagedAttachment(accountId: string, owner: string, stagedId: string) {
  void invoke('release_staged_attachment', {
    accountId: accountId,
    owner: owner,
    id: stagedId,
  });
}

function isRemovedInlineImage(
  attachment: ComposeAttachment,
  previousHtml: string,
  currentHtml: string,
): boolean {
  if (!attachment.contentId || !attachment.staged) return false;
  const assetUrl = attachment.staged.assetUrl;
  return previousHtml.includes(assetUrl) && !currentHtml.includes(assetUrl);
}

function usePruneRemovedInlineImages({
  session,
  accountId,
  owner,
  removeAttachment,
}: {
  session: ComposeSession | null;
  accountId: string;
  owner: string;
  removeAttachment: (localId: string) => void;
}) {
  const previousHtml = useRef(session?.html ?? '');
  useEffect(() => {
    const html = session?.html ?? '';
    if (html === previousHtml.current) return;
    const attachments = session?.attachments ?? [];
    const removedInlineImages = attachments.filter((attachment) =>
      isRemovedInlineImage(attachment, previousHtml.current, html),
    );
    previousHtml.current = html;
    removedInlineImages.forEach((attachment) => {
      removeAttachment(attachment.localId);
      if (attachment.staged) releaseStagedAttachment(accountId, owner, attachment.staged.id);
    });
  }, [session?.html, session?.attachments, accountId, owner, removeAttachment]);
}

export function useAttachmentPipeline(bodyRef: RefObject<BodyEditorHandle | null>) {
  const session = useComposeStore((compose) => compose.session);
  const addReadingAttachment = useComposeStore((compose) => compose.addReadingAttachment);
  const settleAttachment = useComposeStore((compose) => compose.settleAttachment);
  const failAttachment = useComposeStore((compose) => compose.failAttachment);
  const removeAttachment = useComposeStore((compose) => compose.removeAttachment);

  const { accountId, owner } = resolveAttachmentScope(session);
  const stagePathRef = useRef<(path: string, contentId: string | null) => void>(() => undefined);

  const stagePath = useCallback(
    (path: string, contentId: string | null) => {
      const localId = crypto.randomUUID();
      addReadingAttachment({
        localId: localId,
        filename: basename(path),
        mimeType: guessMimeType(path),
        contentId: contentId,
      });
      void stageAttachmentPath({ accountId, owner, path, contentId })
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
  useEffect(() => {
    stagePathRef.current = stagePath;
  }, [stagePath]);

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
      if (attachment?.staged) releaseStagedAttachment(accountId, owner, attachment.staged.id);
    },
    [session?.attachments, removeAttachment, accountId, owner],
  );

  const sessionId = session?.id;
  useEffect(() => {
    if (!sessionId) return;
    return subscribeToFileDrop((paths) =>
      paths.forEach((path) => stagePathRef.current(path, null)),
    );
  }, [sessionId]);

  usePruneRemovedInlineImages({ session, accountId, owner, removeAttachment });

  return { onAttach, onInsertImage, onRemoveAttachment };
}
