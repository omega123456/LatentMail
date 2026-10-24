import { beforeEach, describe, expect, it } from 'vitest';
import { saveMessageAs, type MessageExportTarget } from '@/lib/messages/save';
import { ipc } from '@/tests/ipc-mock';
import { useToastStore } from '@/stores/toast';

const target: MessageExportTarget = {
  accountId: 'account-1',
  messageId: 'message-1',
  subject: 'Invoice',
  sender: 'billing@northwind.example',
  sentAt: new Date(2026, 9, 23),
};

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
});

describe('saveMessageAs', () => {
  it('does nothing when the save dialog is cancelled', async () => {
    const written: string[] = [];
    ipc.override('plugin:dialog|save', null);
    ipc.override('save_message_html_to_path', ({ destination }) => {
      written.push(destination);
    });

    await saveMessageAs('html', target);

    expect(written).toEqual([]);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('offers a web page filter and writes the html export to the chosen path', async () => {
    const filters: string[][] = [];
    const written: string[] = [];
    ipc.override('plugin:dialog|save', ({ options }) => {
      filters.push(options.filters?.[0]?.extensions ?? []);
      return 'C:\\Users\\me\\Invoice copy.html';
    });
    ipc.override('save_message_html_to_path', ({ destination }) => {
      written.push(destination);
    });

    await saveMessageAs('html', target);

    expect(filters).toEqual([['html']]);
    expect(written).toEqual(['C:\\Users\\me\\Invoice copy.html']);
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      severity: 'success',
      message: 'Saved "Invoice copy.html"',
    });
  });

  it('passes the reason from Rust on to the error toast', async () => {
    ipc.override('plugin:dialog|save', '/tmp/Invoice.html');
    ipc.override('save_message_html_to_path', () =>
      Promise.reject('Open the message so its content loads, then try again.'),
    );

    await saveMessageAs('html', target);

    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      severity: 'error',
      message: "Couldn't save the message. Open the message so its content loads, then try again.",
    });
  });

  it('falls back to a generic error toast for an unexpected failure', async () => {
    ipc.override('plugin:dialog|save', '/tmp/Invoice.eml');
    ipc.override('save_message_source_to_path', () => Promise.reject(new Error('disk full')));

    await saveMessageAs('eml', target);

    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      severity: 'error',
      message: "Couldn't save the message.",
    });
  });
});
