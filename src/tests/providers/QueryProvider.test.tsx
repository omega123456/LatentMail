import { useQueryClient } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { QueryProvider } from '@/providers/QueryProvider';

it('provides a query client to descendants', () => {
  const { result } = renderHook(() => useQueryClient(), { wrapper: QueryProvider });

  expect(result.current).toBeDefined();
});
