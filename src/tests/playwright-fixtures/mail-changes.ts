import type { IpcCommandMap } from '@/lib/types/ipc';

export const playwrightMailChangingCommands: string[] = [
  'mutate_threads',
  'mutate_messages',
  'delete_threads',
  'move_threads',
  'delete_messages',
  'move_messages',
  'create_label',
  'rename_label',
  'recolor_label',
  'delete_label',
] satisfies (keyof IpcCommandMap)[];
