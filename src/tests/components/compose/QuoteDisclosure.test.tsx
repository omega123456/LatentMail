import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QuoteDisclosure } from '@/components/compose/QuoteDisclosure';

describe('QuoteDisclosure', () => {
  it('is collapsed by default, showing the trigger but not the quoted content', () => {
    render(
      <QuoteDisclosure
        html="<p>Hi Team, hope you are well.</p>"
        attribution="On 14 Mar 2024 at 10:42, Elena Rodriguez wrote:"
        open={false}
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Show quoted text' })).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Quoted content, read-only' }),
    ).not.toBeInTheDocument();
  });

  it('renders the attribution and the read-only region through BodyFrame when expanded', async () => {
    render(
      <QuoteDisclosure
        html="<p>Hi Team, hope you are well.</p>"
        attribution="On 14 Mar 2024 at 10:42, Elena Rodriguez wrote:"
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Hide quoted text' })).toBeInTheDocument();
    const region = screen.getByRole('region', { name: 'Quoted content, read-only' });
    expect(region).toBeInTheDocument();
    expect(screen.getByText('On 14 Mar 2024 at 10:42, Elena Rodriguez wrote:')).toBeInTheDocument();
    const frame = region.querySelector('iframe');
    expect(frame).toHaveAttribute('sandbox', 'allow-same-origin');
    await waitFor(() => expect(frame).toHaveAttribute('height', '0'));
  });

  it('toggles via the trigger', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <QuoteDisclosure
        html="<p>Hi</p>"
        attribution="Attribution"
        open={false}
        onOpenChange={onOpenChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Show quoted text' }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
