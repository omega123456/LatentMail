import { useLayoutStore } from '@/stores/layout';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSelectionStore } from '@/stores/selection';

export function resetConversationListStores() {
  useLayoutStore.setState({ density: 'comfortable', layout: 'three-column' });
  useSelectionStore.setState({
    activeMailboxId: 'INBOX',
    activeThreadId: null,
    keyboardCursor: null,
    flashThreadId: null,
  });
  useMultiSelectStore.setState({ selectedIds: new Set(), anchorId: null });
}
