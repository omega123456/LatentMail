import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ContactSuggestions } from '@/components/compose/ContactSuggestions';

const named = { address: 'marta.oliveira@example.com', displayName: 'Marta Oliveira' };
const addressOnly = { address: 'marketing@example.com', displayName: null };

describe('ContactSuggestions', () => {
  it('shows a named contact’s address beneath its name, and an address-only contact as its sole line', () => {
    render(
      <ContactSuggestions
        id="list"
        items={[named, addressOnly]}
        activeIndex={-1}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('Marta Oliveira')).toBeInTheDocument();
    expect(screen.getByText('marta.oliveira@example.com')).toBeInTheDocument();
    const addressOnlyOptions = screen.getAllByText('marketing@example.com');
    expect(addressOnlyOptions).toHaveLength(1);
  });

  it('marks the active option via aria-selected and calls onSelect on click', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ContactSuggestions
        id="list"
        items={[named, addressOnly]}
        activeIndex={1}
        onSelect={onSelect}
      />,
    );
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    await user.click(options[0]);
    expect(onSelect).toHaveBeenCalledWith(named);
  });

  it('preserves input focus on selection by preventing default on mousedown', () => {
    render(<ContactSuggestions id="list" items={[named]} activeIndex={0} onSelect={() => {}} />);
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const prevented = !screen.getAllByRole('option')[0].dispatchEvent(event);
    expect(prevented).toBe(true);
  });
});
