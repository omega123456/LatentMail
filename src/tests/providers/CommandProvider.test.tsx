import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMAND_BINDINGS } from '@/lib/keyboard/registry';
import { CommandProvider, useCommandBindings } from '@/providers/CommandProvider';

function Bindings() {
  const bindings = useCommandBindings();
  return <span>{JSON.stringify(bindings)}</span>;
}

describe('CommandProvider', () => {
  it('resolves to the default bindings for a component rendered without a provider', () => {
    render(<Bindings />);
    expect(screen.getByText(JSON.stringify(DEFAULT_COMMAND_BINDINGS))).toBeInTheDocument();
  });

  it('still resolves the defaults when mounted, with no overrides set', () => {
    render(
      <CommandProvider>
        <Bindings />
      </CommandProvider>,
    );
    expect(screen.getByText(JSON.stringify(DEFAULT_COMMAND_BINDINGS))).toBeInTheDocument();
  });
});
