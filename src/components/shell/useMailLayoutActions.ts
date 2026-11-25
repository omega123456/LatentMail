import { useCallback, useEffect, useState, type RefObject } from 'react';
import { useConversationQuery } from '@/lib/query/hooks';
import { mapConversation } from '@/lib/query/mappers';
import { openComposeAction, openNewMessage, type ComposeAction } from '@/lib/compose/entry';
import { useCommands } from '@/lib/keyboard/useCommands';
import type { Account } from '@/lib/types/ipc';
import { useLayoutStore } from '@/stores/layout';
import { selectIsMultiSelectActive, useMultiSelectStore } from '@/stores/multi-select';
import { useMessageSourceStore } from '@/stores/message-source';
import { useSettingsUiStore } from '@/stores/settings-ui';

export function useShellWidth(shellRef: RefObject<HTMLDivElement | null>): number {
  const [shellWidth, setShellWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const node = shellRef.current;
    if (node === null) return;
    const observer = new ResizeObserver((entries) =>
      setShellWidth(entries[0]?.contentRect.width ?? Number.POSITIVE_INFINITY),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [shellRef]);
  return shellWidth;
}

export function useEnsureActiveAccount(
  accounts: Account[],
  activeAccountId: string | null,
  selectAccount: (id: string) => void,
) {
  useEffect(() => {
    if (accounts.length === 0) return;
    const activeAccountStillExists = accounts.some((account) => account.id === activeAccountId);
    if (activeAccountId === null || !activeAccountStillExists) selectAccount(accounts[0].id);
  }, [accounts, activeAccountId, selectAccount]);
}

type MailLayoutCommandsInput = {
  activeAccount: Account | undefined;
  activeAccountId: string | null;
  activeThreadId: string | null;
  searchFieldRef: RefObject<HTMLInputElement | null>;
  toggleAssistant: () => void;
};

export function useMailLayoutCommands({
  activeAccount,
  activeAccountId,
  activeThreadId,
  searchFieldRef,
  toggleAssistant,
}: MailLayoutCommandsInput) {
  const keyboardConversation = useConversationQuery(activeAccountId, activeThreadId);
  const keyboardMultiSelect = useMultiSelectStore(selectIsMultiSelectActive);

  const compose = useCallback(() => {
    if (activeAccount) openNewMessage(activeAccount.id, activeAccount.email);
  }, [activeAccount]);

  const composeTarget = useCallback(
    (action: ComposeAction) => {
      if (!activeAccount || keyboardMultiSelect || !keyboardConversation.data) return;
      void openComposeAction({
        action: action,
        accountId: activeAccount.id,
        accountEmail: activeAccount.email,
        subject: keyboardConversation.data.subject,
        message: mapConversation(keyboardConversation.data).messages.at(-1),
        requireDraftFlag: true,
      });
    },
    [activeAccount, keyboardConversation.data, keyboardMultiSelect],
  );

  const showOriginal = useCallback(() => {
    if (!activeAccount || keyboardMultiSelect || !keyboardConversation.data) return;
    const message = keyboardConversation.data.messages.at(-1);
    if (!message || message.labelIds.includes('DRAFT')) return;
    useMessageSourceStore.getState().open({ accountId: activeAccount.id, messageId: message.id });
  }, [activeAccount, keyboardConversation.data, keyboardMultiSelect]);

  useCommands({
    newMessage: (event) => {
      event.preventDefault();
      compose();
    },
    replyToMessage: (event) => {
      event.preventDefault();
      composeTarget('reply');
    },
    replyAllToMessage: (event) => {
      event.preventDefault();
      composeTarget('reply-all');
    },
    forwardMessage: (event) => {
      event.preventDefault();
      composeTarget('forward');
    },
    editDraft: (event) => {
      event.preventDefault();
      composeTarget('edit-draft');
    },
    focusSearch: (event) => {
      event.preventDefault();
      searchFieldRef.current?.focus();
    },
    toggleAssistant: (event) => {
      event.preventDefault();
      toggleAssistant();
    },
    showOriginal: (event) => {
      event.preventDefault();
      showOriginal();
    },
  });

  return { compose };
}

export function useAssistantControls(refs: {
  assistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
  assistantTrigger: RefObject<HTMLButtonElement | null>;
  assistantRegion: RefObject<HTMLDivElement | null>;
}) {
  const { assistantOpen, setAssistantOpen, assistantTrigger, assistantRegion } = refs;

  const closeAssistant = useCallback(() => {
    setAssistantOpen(false);
    assistantTrigger.current?.focus();
  }, [assistantTrigger, setAssistantOpen]);

  const toggleAssistant = useCallback(() => {
    if (useLayoutStore.getState().assistantOpen) {
      closeAssistant();
      return;
    }
    setAssistantOpen(true);
  }, [closeAssistant, setAssistantOpen]);

  const openAiSettings = useCallback(() => {
    useSettingsUiStore.getState().setActiveSection('ai');
    useLayoutStore.getState().setRoute('settings');
  }, []);

  useEffect(() => {
    if (assistantOpen) assistantRegion.current?.querySelector('textarea')?.focus();
  }, [assistantOpen, assistantRegion]);

  return { closeAssistant, toggleAssistant, openAiSettings };
}
