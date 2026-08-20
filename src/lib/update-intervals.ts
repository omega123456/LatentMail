import { milliseconds } from 'date-fns';
import type { UpdateCheckInterval } from '@/lib/types/ipc';

export const UPDATE_INTERVAL_OPTIONS: { value: UpdateCheckInterval; label: string }[] = [
  { value: '1h', label: 'Every hour' },
  { value: '5h', label: 'Every 5 hours' },
  { value: '1d', label: 'Every day' },
  { value: '7d', label: 'Every 7 days' },
  { value: 'off', label: 'Off' },
];

export const UPDATE_INTERVAL_MS: Record<Exclude<UpdateCheckInterval, 'off'>, number> = {
  '1h': milliseconds({ hours: 1 }),
  '5h': milliseconds({ hours: 5 }),
  '1d': milliseconds({ days: 1 }),
  '7d': milliseconds({ days: 7 }),
};
