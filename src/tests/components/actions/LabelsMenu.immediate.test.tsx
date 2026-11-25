import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { LabelsMenu } from '@/components/actions/LabelsMenu';
import { labels } from '@/tests/components/actions/labels-menu-helpers';

it('commits every toggle immediately and renders no Apply footer', async () => {
  const user = userEvent.setup();
  const onToggle = vi.fn();
  render(<LabelsMenu variant="immediate" labels={labels} onToggle={onToggle} />);
  expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('menuitemcheckbox', { name: /Clients/ }));
  expect(onToggle).toHaveBeenCalledWith('Label_1', false);
  await user.click(screen.getByRole('menuitemcheckbox', { name: /Urgent/ }));
  expect(onToggle).toHaveBeenCalledWith('Label_3', true);
});
