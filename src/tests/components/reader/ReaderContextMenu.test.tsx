import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReaderContextMenu } from '@/components/reader/ReaderContextMenu';

function selectionOf(value: string) {
  vi.spyOn(Selection.prototype, 'toString').mockReturnValue(value);
}

describe('ReaderContextMenu', () => {
  it('copies the selected text', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    selectionOf('  selected body text  ');
    render(
      <ReaderContextMenu>
        <section>body</section>
      </ReaderContextMenu>,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('body') });
    await user.click(await screen.findByRole('menuitem', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('selected body text');
  });

  it('copies the address of a right-clicked link', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    selectionOf('');
    render(
      <ReaderContextMenu>
        <section>
          <a href="https://example.com">link</a>
        </section>
      </ReaderContextMenu>,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('link') });
    await user.click(await screen.findByRole('menuitem', { name: 'Copy link address' }));
    expect(writeText).toHaveBeenCalledWith('https://example.com');
  });

  it('stays closed when there is nothing to copy', async () => {
    const user = userEvent.setup();
    selectionOf('');
    render(
      <ReaderContextMenu>
        <section>body</section>
      </ReaderContextMenu>,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('body') });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
