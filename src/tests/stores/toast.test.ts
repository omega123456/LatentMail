import { describe, expect, it } from 'vitest';
import { useToastStore } from '@/stores/toast';

describe('toast store', () => {
  it('replaces notifications and dismisses the active toast', () => {
    useToastStore.getState().showError('Failed');
    const error = useToastStore.getState().toast;
    useToastStore.getState().showSuccess('Saved');
    expect(useToastStore.getState().toast).toMatchObject({
      id: (error?.id ?? 0) + 1,
      message: 'Saved',
    });
    useToastStore.getState().dismiss();
    expect(useToastStore.getState().toast).toBeNull();
  });
});
