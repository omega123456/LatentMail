import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ComposeFooter } from '@/components/compose/ComposeFooter';

describe('ComposeFooter', () => {
  it('renders the toolbar, a reserved-width status region, enabled attach/image controls and a disabled Send', () => {
    render(
      <ComposeFooter
        editor={null}
        onLink={() => {}}
        onAttach={() => {}}
        onInsertImage={() => {}}
        ready={false}
        status=""
      />,
    );
    expect(screen.getByRole('toolbar', { name: 'Text formatting' })).toBeInTheDocument();
    const attach = screen.getByRole('button', { name: 'Attach files' });
    expect(attach).not.toBeDisabled();
    expect(attach).toHaveAttribute('title', 'Attach files');
    const image = screen.getByRole('button', { name: 'Insert image' });
    expect(image).not.toBeDisabled();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute('title', 'Send');
  });

  it('invokes onAttach and onInsertImage when clicked', async () => {
    const user = userEvent.setup();
    const onAttach = vi.fn();
    const onInsertImage = vi.fn();
    render(
      <ComposeFooter
        editor={null}
        onLink={() => {}}
        onAttach={onAttach}
        onInsertImage={onInsertImage}
        ready={false}
        status=""
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Attach files' }));
    expect(onAttach).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Insert image' }));
    expect(onInsertImage).toHaveBeenCalledTimes(1);
  });

  it('derives recipient readiness onto the disabled Send control without enabling it', () => {
    const { rerender } = render(
      <ComposeFooter
        editor={null}
        onLink={() => {}}
        onAttach={() => {}}
        onInsertImage={() => {}}
        ready={false}
        status=""
      />,
    );
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toHaveAttribute('data-recipient-ready', 'false');
    expect(send).toBeDisabled();
    rerender(
      <ComposeFooter
        editor={null}
        onLink={() => {}}
        onAttach={() => {}}
        onInsertImage={() => {}}
        ready
        status=""
      />,
    );
    expect(send).toHaveAttribute('data-recipient-ready', 'true');
    expect(send).toBeDisabled();
  });

  it('reserves the status region width regardless of content length, so Send never moves', () => {
    const { rerender, container } = render(
      <ComposeFooter
        editor={null}
        onLink={() => {}}
        onAttach={() => {}}
        onInsertImage={() => {}}
        ready={false}
        status=""
      />,
    );
    const statusClass = container.querySelector('[aria-live="polite"]')?.className;
    rerender(
      <ComposeFooter
        editor={null}
        onLink={() => {}}
        onAttach={() => {}}
        onInsertImage={() => {}}
        ready={false}
        status="Draft saved"
      />,
    );
    expect(container.querySelector('[aria-live="polite"]')?.className).toBe(statusClass);
    expect(screen.getByText('Draft saved')).toBeInTheDocument();
  });
});
