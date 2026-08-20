import { describe, expect, it } from 'vitest';
import { useUpdateStore } from '@/stores/update';

describe('update store', () => {
  it('starts with no dismissed version', () => {
    expect(useUpdateStore.getState().dismissedVersion).toBeNull();
  });

  it('remembers the dismissed version', () => {
    useUpdateStore.getState().dismiss('0.1.1');
    expect(useUpdateStore.getState().dismissedVersion).toBe('0.1.1');
  });
});
