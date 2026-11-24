import { screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

const UNMEASURED_FRAME_HEIGHT = '1';

function isAwaitingMeasurement(frame: HTMLElement) {
  return frame.getAttribute('height') === UNMEASURED_FRAME_HEIGHT;
}

export async function waitForBodyFramesToSettle() {
  await waitFor(() => {
    const unmeasured = screen.queryAllByTitle('Message body').filter(isAwaitingMeasurement);
    expect(unmeasured).toHaveLength(0);
  });
}
