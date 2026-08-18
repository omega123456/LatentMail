import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { KeyCaps } from '@/components/settings/KeyCaps';

function setPlatform(platform: string) {
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
}

describe('KeyCaps', () => {
  afterEach(() => setPlatform(''));

  it('shows an explicit "Not set" state for a command with no reachable binding', () => {
    render(<KeyCaps bindings={[]} />);
    expect(screen.getByText('Not set')).toBeInTheDocument();
  });

  it('renders Mac symbols on a Mac platform', () => {
    setPlatform('MacIntel');
    render(<KeyCaps bindings={['Meta+Shift+A']} />);
    expect(screen.getByText('⌘')).toBeInTheDocument();
    expect(screen.getByText('⇧')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('renders Windows-style text on a non-Mac platform', () => {
    setPlatform('Win32');
    render(<KeyCaps bindings={['Control+Shift+A']} />);
    expect(screen.getByText('Ctrl')).toBeInTheDocument();
    expect(screen.getByText('Shift')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });
});
