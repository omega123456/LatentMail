import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DropdownMenu } from 'radix-ui';

describe('radix-ui smoke test', () => {
  it('opens a Radix dropdown menu and lets an item be activated', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>Open menu</DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <DropdownMenu.Item>Item one</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>,
    );

    expect(screen.queryByText('Item one')).not.toBeInTheDocument();

    await user.click(screen.getByText('Open menu'));

    expect(await screen.findByText('Item one')).toBeInTheDocument();
  });
});
