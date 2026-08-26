import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AssistantNotice } from '@/components/ai-chat/AssistantNotice';
import type { AssistantUnavailableCause } from '@/components/ai-chat/AssistantNotice';

function renderNotice(cause: AssistantUnavailableCause, onAction = vi.fn()) {
  return {
    onAction,
    ...render(
      <AssistantNotice
        cause={cause}
        accountEmail="alex@example.com"
        indexed={2140}
        total={8600}
        endpoint="https://api.example.com/v1"
        onAction={onAction}
      />,
    ),
  };
}

describe('AssistantNotice', () => {
  it('names the account when AI is turned off', () => {
    renderNotice('disabled');
    expect(screen.getByText('AI is turned off for this account')).toBeInTheDocument();
    expect(screen.getByText(/alex@example.com/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open AI settings' })).toBeInTheDocument();
  });

  it('asks for an API root', () => {
    renderNotice('noApiRoot');
    expect(screen.getByText('No API root saved')).toBeInTheDocument();
  });

  it('asks for a chat model', () => {
    renderNotice('noChatModel');
    expect(screen.getByText('No chat model selected')).toBeInTheDocument();
  });

  it('routes a legacy index to the rebuild control', async () => {
    const user = userEvent.setup();
    const { onAction } = renderNotice('needsRebuild');
    expect(screen.getByText('The index must be rebuilt')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Rebuild the index' }));
    expect(onAction).toHaveBeenCalledWith('needsRebuild');
  });

  it('shows the indexed and eligible counts while the index is still building', () => {
    renderNotice('indexNotReady');
    expect(screen.getByText('The index is still building')).toBeInTheDocument();
    expect(screen.getByText(/2,140 of 8,600 messages are indexed/)).toBeInTheDocument();
  });

  it('names the unreachable host and takes the error accent', () => {
    const { container } = renderNotice('unreachable');
    expect(screen.getByText('Cannot reach the provider')).toBeInTheDocument();
    expect(screen.getByText(/api\.example\.com/)).toBeInTheDocument();
    expect(container.querySelector('span[aria-hidden="true"]')).toHaveClass('bg-error');
    expect(screen.getByRole('button', { name: 'Test the connection' })).toBeInTheDocument();
  });

  it('falls back to plain wording when there is no usable endpoint', () => {
    const { rerender } = render(
      <AssistantNotice
        cause="unreachable"
        accountEmail="alex@example.com"
        indexed={0}
        total={0}
        endpoint={null}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText(/the provider failed/)).toBeInTheDocument();
    rerender(
      <AssistantNotice
        cause="unreachable"
        accountEmail="alex@example.com"
        indexed={0}
        total={0}
        endpoint="not a url"
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText(/not a url failed/)).toBeInTheDocument();
  });
});
