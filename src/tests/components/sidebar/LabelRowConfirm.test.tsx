import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LabelRowConfirm } from '@/components/sidebar/LabelRowConfirm';

describe('LabelRowConfirm', () => {
  it('confirms and cancels', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<LabelRowConfirm labelName="Travel" onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByText("Remove 'Travel'?")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'No' }));
    expect(onCancel).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
