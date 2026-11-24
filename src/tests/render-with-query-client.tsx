import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export type TestQueryClientOptions = {
  retry?: boolean;
};

export function createTestQueryClient(options: TestQueryClientOptions = {}) {
  if (options.retry === false) {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } });
  }
  return new QueryClient();
}

export function renderWithQueryClient(
  ui: ReactElement,
  options: TestQueryClientOptions & { client?: QueryClient } = {},
) {
  const client = options.client ?? createTestQueryClient(options);
  const utils = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return {
    ...utils,
    client: client,
    rerender: (next: ReactElement) =>
      utils.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>),
  };
}
