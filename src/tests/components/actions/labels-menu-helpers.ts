import type { LabelMenuEntry } from '@/components/actions/LabelsMenu';

export const labels: LabelMenuEntry[] = [
  { id: 'Label_1', name: 'Clients', color: 'blue', membership: 'checked' },
  { id: 'Label_2', name: 'Invoices', color: 'red', membership: 'indeterminate' },
  { id: 'Label_3', name: 'Urgent', color: 'orange', membership: 'unchecked' },
];
