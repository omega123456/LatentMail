import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { parseISO } from 'date-fns';
import { MessageHeader } from '@/components/reader/MessageHeader';

describe('MessageHeader', () => {
  it('opens a pre-addressed compose for the sender and first recipient', async () => {
    const user = userEvent.setup();
    const compose = vi.fn();
    render(
      <MessageHeader
        sender={{ name: 'Elena', address: 'elena@example.com' }}
        recipients={[
          { name: 'Me', address: 'me@example.com' },
          { name: 'Team', address: 'team@example.com' },
        ]}
        sentAt={parseISO('2026-08-13T12:00:00Z')}
        onComposeTo={compose}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Elena' }));
    await user.click(screen.getByRole('button', { name: /to Me/ }));
    expect(compose).toHaveBeenNthCalledWith(1, { name: 'Elena', address: 'elena@example.com' });
    expect(compose).toHaveBeenNthCalledWith(2, { name: 'Me', address: 'me@example.com' });
  });
});
