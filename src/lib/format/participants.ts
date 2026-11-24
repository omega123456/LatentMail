export type Participant = { name: string; address: string };

const MAX_LISTED_PARTICIPANTS = 2;

export function formatParticipants(participants: Participant[]) {
  const names = participants.map(({ name, address }) => name || address);
  if (names.length <= MAX_LISTED_PARTICIPANTS) return names.join(', ');
  return `${names[0]} and ${names.length - 1} others`;
}

const NAME_AND_ADDRESS = /^\s*(.*?)\s*<([^<>]+)>\s*$/;

export function parseParticipant(raw: string): Participant {
  const match = NAME_AND_ADDRESS.exec(raw);
  if (match) return { name: match[1].replace(/^"|"$/g, ''), address: match[2] };
  return { name: '', address: raw.trim() };
}

export function addressKey(raw: string): string {
  return parseParticipant(raw).address.trim().toLowerCase();
}
