export type Participant = { name: string; address: string };

export function formatParticipants(participants: Participant[]) {
  const names = participants.map(({ name, address }) => name || address);
  if (names.length <= 2) return names.join(', ');
  return `${names[0]} and ${names.length - 1} others`;
}

const NAME_AND_ADDRESS = /^\s*(.*?)\s*<([^<>]+)>\s*$/;

/** Parses a raw RFC 5322 `From`/`To` header value ("Name <addr>" or a bare
 * address) as stored by Rust into the `{ name, address }` shape the reader
 * components render. */
export function parseParticipant(raw: string): Participant {
  const match = NAME_AND_ADDRESS.exec(raw);
  if (match) return { name: match[1].replace(/^"|"$/g, ''), address: match[2] };
  return { name: '', address: raw.trim() };
}
