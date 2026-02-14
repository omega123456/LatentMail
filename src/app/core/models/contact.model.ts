export interface Contact {
  id: number;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  frequency: number;
  lastContactedAt?: string;
}
