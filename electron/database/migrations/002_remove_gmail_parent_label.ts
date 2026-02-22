import type { MigrationContext } from './001_initial_schema';

/**
 * Remove the phantom "[Gmail]" parent mailbox from labels.
 * IMAP LIST returns it as a container; it is not a real folder and should not appear in the sidebar.
 */
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  context.db.run("DELETE FROM labels WHERE gmail_label_id = '[Gmail]'");
}

export async function down(): Promise<void> {
  // No-op: we do not re-create the phantom label.
}
