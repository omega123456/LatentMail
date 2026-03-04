/** Metadata describing a single CLI command. */
export interface CliCommandMeta {
  name: string;
  description: string;
}

/**
 * Authoritative list of CLI commands and their descriptions.
 *
 * ZERO IMPORTS — this file must remain import-free so it is safe to load
 * in the CLI client process (ELECTRON_RUN_AS_NODE=1) which cannot import
 * Electron APIs, services, or any module that transitively depends on them.
 */
export const CLI_COMMANDS_META: CliCommandMeta[] = [
  { name: 'pause-sync', description: 'Pause background email sync' },
  { name: 'resume-sync', description: 'Resume background email sync' },
];
