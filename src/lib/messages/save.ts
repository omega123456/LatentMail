import { messageExportFilename } from '@/lib/attachments/filename';
import { invoke } from '@/lib/ipc/commands';
import { useToastStore } from '@/stores/toast';

export type MessageExportFormat = 'eml' | 'html';

export type MessageExportTarget = {
  accountId: string;
  messageId: string;
  subject: string;
  sender: string;
  sentAt: Date;
};

const EXPORT_FILTERS: Record<MessageExportFormat, { name: string; extensions: string[] }> = {
  eml: { name: 'Email message', extensions: ['eml'] },
  html: { name: 'Web page', extensions: ['html'] },
};

export async function saveMessageAs(
  exportFormat: MessageExportFormat,
  target: MessageExportTarget,
) {
  const destination = await invoke('plugin:dialog|save', {
    options: {
      defaultPath: messageExportFilename({
        subject: target.subject,
        sentAt: target.sentAt,
        sender: target.sender,
        extension: exportFormat,
      }),
      filters: [EXPORT_FILTERS[exportFormat]],
    },
  });
  if (!destination) return;
  const request = {
    accountId: target.accountId,
    messageId: target.messageId,
    destination: destination,
  };
  const { showSuccess, showError } = useToastStore.getState();
  try {
    await (exportFormat === 'eml'
      ? invoke('save_message_source_to_path', request)
      : invoke('save_message_html_to_path', request));
    showSuccess(`Saved "${destination.split(/[/\\]/).pop()}"`);
  } catch (error) {
    showError(
      typeof error === 'string'
        ? `Couldn't save the message. ${error}`
        : "Couldn't save the message.",
    );
  }
}
