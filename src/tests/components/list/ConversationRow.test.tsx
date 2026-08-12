import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConversationRow } from '@/components/list/ConversationRow';
import type { Conversation } from '@/lib/types/conversation';

const conversation: Conversation = {
  id: 'thread-1',
  sender: 'Elena Rodriguez',
  subject: 'Q3 review',
  snippet: 'Attached slides',
  date: new Date('2026-08-11T10:42:00Z'),
  unread: false,
  starred: false,
};

describe('ConversationRow', () => {
  it('shows the active highlight when active and no multi-selection is in play', () => {
    render(
      <ConversationRow
        conversation={conversation}
        density="comfortable"
        active
        mailboxId="INBOX"
        onOpen={vi.fn()}
        onStar={vi.fn()}
      />,
    );
    expect(screen.getByTestId('conversation-row')).toHaveAttribute('data-active', 'true');
  });

  it('suppresses the active highlight whenever a multi-selection is active, even on an unselected row', () => {
    render(
      <ConversationRow
        conversation={conversation}
        density="comfortable"
        active
        multiSelectActive
        mailboxId="INBOX"
        onOpen={vi.fn()}
        onStar={vi.fn()}
      />,
    );
    expect(screen.getByTestId('conversation-row')).not.toHaveAttribute('data-active');
  });

  it('renders the selected accent bar and never the active highlight at the same time', () => {
    render(
      <ConversationRow
        conversation={conversation}
        density="comfortable"
        active
        selected
        multiSelectActive
        mailboxId="INBOX"
        onOpen={vi.fn()}
        onStar={vi.fn()}
      />,
    );
    const row = screen.getByTestId('conversation-row');
    expect(row).toHaveAttribute('data-selected', 'true');
    expect(row).not.toHaveAttribute('data-active');
  });

  it('passes the click event through to onOpen so modifier clicks can be told apart', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <ConversationRow
        conversation={conversation}
        density="comfortable"
        active={false}
        mailboxId="INBOX"
        onOpen={onOpen}
        onStar={vi.fn()}
      />,
    );
    await user.click(screen.getByLabelText('Open Q3 review'));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen.mock.calls[0][0]).toMatchObject({ type: 'click' });
  });

  it('opens plainly (no modifiers) from the row context menu', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <ConversationRow
        conversation={conversation}
        density="comfortable"
        active={false}
        mailboxId="INBOX"
        onOpen={onOpen}
        onStar={vi.fn()}
      />,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('conversation-row') });
    await user.click(await screen.findByText('Open'));
    expect(onOpen).toHaveBeenCalledWith({ shiftKey: false, metaKey: false, ctrlKey: false });
  });

  it('dispatches context-menu triage changes instead of dropping them', async () => {
    const user = userEvent.setup();
    const onTriage = vi.fn();
    render(
      <ConversationRow
        conversation={{ ...conversation, unread: true }}
        density="comfortable"
        active={false}
        mailboxId="INBOX"
        onOpen={vi.fn()}
        onStar={vi.fn()}
        onTriage={onTriage}
      />,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('conversation-row') });
    await user.click(await screen.findByText('Mark read'));
    expect(onTriage).toHaveBeenCalledWith({ add: [], remove: ['UNREAD'] });
  });
});
