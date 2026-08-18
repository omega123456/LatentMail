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

  it('refetches a message marked fetched that stored neither body part', () => {
    const onFetchBody = vi.fn();
    renderWithQueryClient(
      <MessageCard
        message={{ ...message, htmlPresence: 'absent' }}
        expanded
        newest
        onFetchBody={onFetchBody}
      />,
    );
    expect(onFetchBody).toHaveBeenCalledWith('message-1');
    expect(screen.getByText('This message has no content.')).toBeInTheDocument();
  });

  it('leaves a message that already has a plain body alone', () => {
    const onFetchBody = vi.fn();
    renderWithQueryClient(
      <MessageCard
        message={{ ...message, htmlPresence: 'absent', text: 'Undelivered mail' }}
        expanded
        newest
        onFetchBody={onFetchBody}
      />,
    );
    expect(onFetchBody).not.toHaveBeenCalled();
    expect(screen.getByText('Undelivered mail')).toBeInTheDocument();
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

  it('offers both bypasses on the blocked banner and reports the sender address lowercased', async () => {
    const user = userEvent.setup();
    const onLoadImages = vi.fn();
    const onTrustSender = vi.fn();
    renderWithQueryClient(
      <MessageCard
        message={{
          ...message,
          html: '<p>Body</p>',
          htmlPresence: 'present',
          labelIds: ['INBOX'],
          remoteImagesBlocked: true,
        }}
        expanded
        newest
        onLoadImages={onLoadImages}
        onTrustSender={onTrustSender}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Load images' }));
    expect(onLoadImages).toHaveBeenCalledWith('message-1');
    await user.click(screen.getByRole('button', { name: 'Always allow from Alex' }));
    expect(onTrustSender).toHaveBeenCalledWith('alex@example.com');
  });

  it('offers no bypass at all on a spammed message', () => {
    renderWithQueryClient(
      <MessageCard
        message={{
          ...message,
          html: '<p>Body</p>',
          htmlPresence: 'present',
          labelIds: ['SPAM'],
          remoteImagesBlocked: true,
        }}
        expanded
        newest
      />,
    );
    expect(screen.getByText('Remote images are blocked.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load images' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Always allow from/ })).not.toBeInTheDocument();
  });

  it('widens the body frame image policy only when the message is allowed', () => {
    const { rerender } = renderWithQueryClient(
      <MessageCard
        message={{ ...message, html: '<p>Body</p>', htmlPresence: 'present' }}
        expanded
        newest
      />,
    );
    const blockedFrame = screen.getByLabelText('Message body') as HTMLIFrameElement;
    expect(blockedFrame.srcdoc).toContain('img-src data:;');
    rerender(
      <MessageCard
        message={{
          ...message,
          html: '<p>Body</p>',
          htmlPresence: 'present',
          remoteImagesAllowed: true,
        }}
        expanded
        newest
      />,
    );
    const allowedFrame = screen.getByLabelText('Message body') as HTMLIFrameElement;
    expect(allowedFrame.srcdoc).toContain('img-src data: https: http:;');
  });

  it('toggles the message from a click on its row without hijacking the sender button', async () => {
    const user = userEvent.setup();
    const onComposeTo = vi.fn();
    renderWithQueryClient(
      <MessageCard
        message={{ ...message, html: '<p>Body</p>', htmlPresence: 'present' }}
        expanded={false}
        newest={false}
        onComposeTo={onComposeTo}
      />,
    );
    await user.click(screen.getByText('Preview'));
    expect(screen.getByLabelText('Message body')).toBeInTheDocument();
    await user.click(screen.getByText('Alex'));
    expect(onComposeTo).toHaveBeenCalledWith(message.sender);
    expect(screen.getByLabelText('Message body')).toBeInTheDocument();
    await user.click(screen.getByRole('time'));
    expect(screen.queryByLabelText('Message body')).not.toBeInTheDocument();
  });
});
