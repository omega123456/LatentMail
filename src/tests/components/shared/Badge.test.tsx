import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from '@/components/shared/Badge';
import { LABEL_COLOR_BY_ID, LABEL_COLOR_PALETTE } from '@/lib/labels/palette';

function renderBadge(node: React.ReactNode) {
  return render(<ul>{node}</ul>);
}

describe('Badge', () => {
  it('paints a system badge with its own hue pair in both themes', () => {
    renderBadge(<Badge badge={{ kind: 'system', id: 'INBOX' }} />);
    const badge = screen.getByTitle('Inbox');
    expect(badge).toHaveTextContent('Inbox');
    expect(badge).toHaveClass('bg-badge-inbox', 'text-badge-on-inbox');
    expect(badge).toHaveClass('dark:bg-dark-badge-inbox', 'dark:text-dark-badge-on-inbox');
  });

  it('reuses the star token so the Starred badge matches the star icon', () => {
    renderBadge(<Badge badge={{ kind: 'system', id: 'STARRED' }} />);
    expect(screen.getByTitle('Starred')).toHaveClass('text-star', 'dark:text-dark-star');
  });

  it('tints a user label with its own swatch and keeps the ink readable', () => {
    renderBadge(<Badge badge={{ kind: 'user', id: 'Label_1', name: 'Invoices', color: 'blue' }} />);
    const swatch = LABEL_COLOR_BY_ID.blue;
    const badge = screen.getByTitle('Invoices');
    expect(badge).toHaveClass(...swatch.tintClass.split(' '));
    expect(badge).toHaveClass(...swatch.borderClass.split(' '));
    expect(badge).toHaveClass(...swatch.inkClass.split(' '));
  });

  it('falls back to the first swatch when a label carries an unknown colour', () => {
    renderBadge(
      <Badge badge={{ kind: 'user', id: 'Label_1', name: 'Invoices', color: 'not-a-colour' }} />,
    );
    expect(screen.getByTitle('Invoices')).toHaveClass(
      ...LABEL_COLOR_PALETTE[0].tintClass.split(' '),
    );
  });

  it('keeps the name available to assistive tech when only the icon is shown', () => {
    renderBadge(
      <Badge badge={{ kind: 'user', id: 'Label_1', name: 'Invoices', color: 'blue' }} iconOnly />,
    );
    expect(screen.getByText('Invoices')).toHaveClass('sr-only');
  });
});
