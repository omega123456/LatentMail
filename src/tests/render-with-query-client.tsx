import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/** Wraps `render`/`rerender` in a fresh `QueryClientProvider` for tests that
 * mount a component owning its own TanStack Query hook (e.g. the avatar
 * queries) but don't otherwise exercise query behaviour — mirrors the ad hoc
 * `QueryClientProvider` wrapper every query-aware container test already
 * hand-rolls (see `ConversationListContainer.test.tsx`), just reusable. */
export function renderWithQueryClient(ui: ReactElement) {
  const client = new QueryClient();
  const utils = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return {
    ...utils,
    rerender: (next: ReactElement) =>
      utils.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>),
  };
}
