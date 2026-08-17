import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BodyFrame } from '@/components/reader/BodyFrame';
import { ipc } from '@/tests/ipc-mock';

describe('BodyFrame', () => {
  it('renders empty and plain alternatives without an iframe', () => {
    const { rerender } = render(<BodyFrame html={null} text={null} />);
    expect(screen.getByText('This message has no content.')).toBeInTheDocument();
    rerender(<BodyFrame html={null} text={'Plain body'} />);
    expect(screen.getByText('Plain body')).toBeInTheDocument();
  });

  it('sanitizes HTML and opens clicked links through centralized IPC', async () => {
    const openExternal = vi.fn();
    ipc.override('open_external_url', openExternal);
    render(
      <BodyFrame
        html={'<a href="https://example.com">Safe link</a><script>bad()</script>'}
        text={null}
      />,
    );
    const frame = screen.getByTitle('Message body') as HTMLIFrameElement;
    expect(frame).toHaveAttribute('sandbox', 'allow-same-origin');
    expect(frame.getAttribute('srcdoc')).not.toContain('<script>');
    frame.contentDocument?.write('<a href="https://example.com">Safe link</a>');
    await act(async () => {
      fireEvent.load(frame);
      await Promise.resolve();
    });
    const link = frame.contentDocument?.querySelector('a');
    expect(link).not.toBeNull();
    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openExternal).toHaveBeenCalledWith({ url: 'https://example.com' });
  });

  it('cancels the native right-click menu inside the message frame', async () => {
    render(<BodyFrame html={'<p>Body</p>'} text={null} />);
    const frame = screen.getByTitle('Message body') as HTMLIFrameElement;
    frame.contentDocument?.write('<p>Body</p>');
    await act(async () => {
      fireEvent.load(frame);
      await Promise.resolve();
    });
    const paragraph = frame.contentDocument?.querySelector('p');
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    paragraph?.dispatchEvent(menu);

    expect(menu.defaultPrevented).toBe(true);
  });
});
