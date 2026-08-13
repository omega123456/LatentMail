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

/** Owns the whole attachment/inline-image pipeline for the open composer:
 * the Attach picker, native file drop, the Insert Image picker, staging
 * every resulting path through Rust, and releasing a staged part when its
 * chip is removed or its inline image is deleted from the body. Kept as one
 * hook (rather than split across `ComposeFooter`/`ComposeOverlay`) because
 * every one of these actions ultimately drives the same
 * `stage → settle/fail` state machine on the compose store. */
export function useAttachmentPipeline(bodyRef: RefObject<BodyEditorHandle | null>) {
  const session = useComposeStore((state) => state.session);
  const addReadingAttachment = useComposeStore((state) => state.addReadingAttachment);
  const settleAttachment = useComposeStore((state) => state.settleAttachment);
  const failAttachment = useComposeStore((state) => state.failAttachment);
  const removeAttachment = useComposeStore((state) => state.removeAttachment);

  const accountId = session?.accountId ?? '';
  // Canonical parts transfer to the stable Gmail draft owner after first
  // save. Subsequent adds/removals must use that current owner.
  const owner = session?.draftId ?? session?.id ?? '';

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
      // A reading chip's in-flight `stageAttachmentPath` still resolves
      // later; `settleAttachment`/`failAttachment` both no-op once the
      // entry is gone, so there is nothing else to cancel here.
    },
    [session?.attachments, removeAttachment, accountId, owner],
  );

  // Native drop (D7) — subscribed for the composer's lifetime, torn down on
  // unmount/close, and the app's only drag-drop consumer.
  useEffect(() => {
    if (!session) return;
    return subscribeToFileDrop((paths) => paths.forEach((path) => stagePath(path, null)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resubscribing on every `stagePath` identity change would tear down and rebuild the native listener far more than necessary; `session?.id` is the meaningful dependency.
  }, [session?.id]);

  // Revokes an inline image's staged part once the user deletes it from the
  // editable body — the only removal path for an inline image, since it
  // never renders as a chip. Diffs the previous/next HTML's asset-URL
  // references rather than inspecting Tiptap transactions directly.
  // ponytail: O(attachments) substring scan per body change; fine at the
  // handful-of-images-per-message scale compose ever sees, revisit with a
  // node-id-keyed editor plugin if that stops being true.
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
