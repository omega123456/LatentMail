import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getTime, parseISO, subYears } from 'date-fns';
import { describe, expect, it, vi } from 'vitest';
import { AssistantSources } from '@/components/ai-chat/AssistantSources';
import type { AiChatSource } from '@/lib/types/ipc';

const source = (overrides: Partial<AiChatSource> = {}): AiChatSource => ({
  number: 1,
  senderName: 'Dan Okonjo',
  senderAddress: 'dan@northgate.co',
  subject: 'Re: venue change for Thursday',
  sentAtMillis: getTime(new Date()),
  messageId: 'message-1',
  threadId: 'thread-1',
  ...overrides,
});

describe('AssistantSources', () => {
  it('renders nothing when the answer cited nothing valid', () => {
    const { container } = render(<AssistantSources sources={[]} onActivate={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one activatable card per cited email with its number, sender and subject', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const cited = source();
    render(
      <AssistantSources
        sources={[cited, source({ number: 2, messageId: 'message-2', senderName: '' })]}
        onActivate={onActivate}
      />,
    );
    const cards = screen.getAllByRole('button');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent('1');
    expect(cards[0]).toHaveTextContent('Dan Okonjo');
    expect(cards[1]).toHaveTextContent('dan@northgate.co');
    expect(screen.getAllByTitle('Re: venue change for Thursday')).toHaveLength(2);

    await user.click(cards[0]);
    expect(onActivate).toHaveBeenCalledWith(cited);
    cards[1].focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onActivate).toHaveBeenCalledTimes(3);
  });

  it('adds the year to a date outside the current year', () => {
    const now = parseISO('2026-08-26T09:00:00.000Z');
    const older = getTime(subYears(now, 2));
    render(
      <AssistantSources
        sources={[
          source({ sentAtMillis: getTime(now) }),
          source({ number: 2, sentAtMillis: older }),
        ]}
        onActivate={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('button')[1]).toHaveTextContent('2024');
  });
});
