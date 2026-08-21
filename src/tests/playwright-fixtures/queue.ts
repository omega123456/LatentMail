import { addSeconds, getUnixTime, parseISO, subSeconds } from 'date-fns';
import type { IpcCommandMap } from '@/lib/types/ipc';

export const playwrightQueueSummary: IpcCommandMap['read_queue_summary']['result'] = {
  pending: 0,
  active: 0,
  failed: 0,
  done: 0,
  paused: false,
  suspended: false,
};

export const playwrightPausedQueueSummary: IpcCommandMap['pause_queue']['result'] = {
  ...playwrightQueueSummary,
  paused: true,
};

export const playwrightResumedQueueSummary: IpcCommandMap['resume_queue']['result'] = {
  ...playwrightQueueSummary,
  paused: false,
};

const QUEUE_FIXTURE_NOW = parseISO('2026-08-18T12:00:00Z');
const secondsAgo = (amount: number) => getUnixTime(subSeconds(QUEUE_FIXTURE_NOW, amount));
const secondsFromNow = (amount: number) => getUnixTime(addSeconds(QUEUE_FIXTURE_NOW, amount));

export const playwrightQueueOperationsSnapshot: IpcCommandMap['read_queue_operations']['result'] = [
  {
    accountId: 'mail-account',
    active: 4,
    queued: 3,
    failed: 0,
    lanes: [
      {
        lane: 'interactive',
        capacity: 4,
        active: 4,
        backlog: 2,
        state: 'running',
        operations: [
          {
            id: 'op-active-1',
            accountId: 'mail-account',
            lane: 'interactive',
            kind: 'send',
            description: 'Re: Q3 review',
            status: 'active',
            attempts: 1,
            error: null,
            retryable: true,
            nextAttemptAt: null,
            createdAt: secondsAgo(4),
            updatedAt: secondsAgo(2),
          },
          {
            id: 'op-queued-1',
            accountId: 'mail-account',
            lane: 'interactive',
            kind: 'labelMutation',
            description: 'Add "Receipts" to 3 conversations',
            status: 'queued',
            attempts: 0,
            error: null,
            retryable: false,
            nextAttemptAt: null,
            createdAt: secondsAgo(6),
            updatedAt: secondsAgo(6),
          },
        ],
      },
      {
        lane: 'background',
        capacity: 2,
        active: 0,
        backlog: 1,
        state: 'blocked',
        operations: [
          {
            id: 'op-blocked-1',
            accountId: 'mail-account',
            lane: 'background',
            kind: 'markRead',
            description: 'Mark 12 conversations read',
            status: 'queued',
            attempts: 0,
            error: null,
            retryable: false,
            nextAttemptAt: null,
            createdAt: secondsAgo(10),
            updatedAt: secondsAgo(10),
          },
        ],
      },
      {
        lane: 'traversal',
        capacity: 1,
        active: 0,
        backlog: 0,
        state: 'idle',
        operations: [],
      },
    ],
  },
  {
    accountId: 'reauth-account',
    active: 0,
    queued: 1,
    failed: 1,
    lanes: [
      {
        lane: 'interactive',
        capacity: 4,
        active: 0,
        backlog: 2,
        state: 'paused',
        operations: [
          {
            id: 'op-failed-1',
            accountId: 'reauth-account',
            lane: 'interactive',
            kind: 'send',
            description: 'Budget approval',
            status: 'failed',
            attempts: 3,
            error: 'Gmail request failed with status 500',
            retryable: true,
            nextAttemptAt: null,
            createdAt: secondsAgo(120),
            updatedAt: secondsAgo(30),
          },
          {
            id: 'op-retrying-1',
            accountId: 'reauth-account',
            lane: 'interactive',
            kind: 'draft',
            description: 'Draft — Team offsite notes',
            status: 'retrying',
            attempts: 2,
            error: null,
            retryable: true,
            nextAttemptAt: secondsFromNow(30),
            createdAt: secondsAgo(90),
            updatedAt: secondsAgo(5),
          },
        ],
      },
      {
        lane: 'background',
        capacity: 2,
        active: 0,
        backlog: 0,
        state: 'paused',
        operations: [],
      },
      {
        lane: 'traversal',
        capacity: 1,
        active: 0,
        backlog: 0,
        state: 'paused',
        operations: [],
      },
    ],
  },
  {
    accountId: 'sidebar-account',
    active: 0,
    queued: 0,
    failed: 0,
    lanes: [
      { lane: 'interactive', capacity: 4, active: 0, backlog: 0, state: 'idle', operations: [] },
      { lane: 'background', capacity: 2, active: 0, backlog: 0, state: 'idle', operations: [] },
      { lane: 'traversal', capacity: 1, active: 0, backlog: 0, state: 'idle', operations: [] },
    ],
  },
];
