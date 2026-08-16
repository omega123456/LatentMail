import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MessageCard } from '@/components/reader/MessageCard';
import { renderWithQueryClient } from '@/tests/render-with-query-client';

const message = {
  id: 'message-1',
  sender: { name: 'Alex', address: 'alex@example.com' },
  recipients: [],
  sentAt: new Date('2026-08-10T09:00:00Z'),
  snippet: 'Preview',
  html: null,
  text: null,
};

describe('MessageCard', () => {
  it('fetches a newly opened lazy body once and exposes loading and retry states', async () => {
    const onFetchBody = vi.fn();
    const { rerender } = renderWithQueryClient(
      <MessageCard
        message={{ ...message, htmlPresence: 'neverFetched' }}
        expanded
        newest
        onFetchBody={onFetchBody}
        loadingBody
      />,
    );
    expect(onFetchBody).toHaveBeenCalledWith('message-1');
    expect(screen.getByText('Loading message…')).toBeInTheDocument();
    rerender(
      <MessageCard
        message={{ ...message, htmlPresence: 'neverFetched' }}
        expanded
        newest
        onFetchBody={onFetchBody}
        bodyError
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onFetchBody).toHaveBeenCalledTimes(2);
  });

  it('expands an older message and shows blocked-image notice', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <MessageCard
        message={{
          ...message,
          html: '<p>Body</p>',
          htmlPresence: 'present',
          remoteImagesBlocked: true,
        }}
        expanded={false}
        newest={false}
      />,
    );
    expect(screen.getByText('Preview')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand message from Alex' }));
    expect(screen.getByText('Remote images are blocked.')).toBeInTheDocument();
    expect(screen.getByLabelText('Message body')).toBeInTheDocument();
  });
});
