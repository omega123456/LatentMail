import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { InlineConfirm } from '@/components/settings/InlineConfirm';

it('confirms or cancels inline actions', async () => {
  const user = userEvent.setup();
  const confirm = vi.fn();
  const cancel = vi.fn();
  render(
    <InlineConfirm
      title="Title"
      body="Body"
      action="Clear"
      onConfirm={confirm}
      onCancel={cancel}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(screen.getByRole('button', { name: 'Clear' }));
  expect(cancel).toHaveBeenCalledOnce();
  expect(confirm).toHaveBeenCalledOnce();
});
