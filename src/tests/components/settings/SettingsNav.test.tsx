import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SettingsNav } from '@/components/settings/SettingsNav';

describe('SettingsNav', () => {
  it('lists Back to Mail and the five sections in order, marking the active one', () => {
    render(
      <SettingsNav
        activeSection="general"
        onSelectSection={() => undefined}
        onBackToMail={() => undefined}
      />,
    );

    const nav = screen.getByRole('navigation', { name: 'Settings' });
    const buttons = within(nav).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Mail',
      'General',
      'Accounts',
      'Keyboard',
      'Queue',
      'Logs',
    ]);
    expect(screen.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Accounts' })).not.toHaveAttribute('aria-current');
  });

  it('calls onBackToMail when Back to Mail is clicked', async () => {
    const user = userEvent.setup();
    const onBackToMail = vi.fn();
    render(
      <SettingsNav
        activeSection="general"
        onSelectSection={() => undefined}
        onBackToMail={onBackToMail}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Back to Mail' }));
    expect(onBackToMail).toHaveBeenCalledOnce();
  });

  it('calls onSelectSection with the clicked section', async () => {
    const user = userEvent.setup();
    const onSelectSection = vi.fn();
    render(
      <SettingsNav
        activeSection="general"
        onSelectSection={onSelectSection}
        onBackToMail={() => undefined}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Queue' }));
    expect(onSelectSection).toHaveBeenCalledWith('queue');
  });
});
