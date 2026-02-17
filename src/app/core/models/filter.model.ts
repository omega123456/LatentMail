export interface FilterCondition {
  field: 'from' | 'to' | 'subject' | 'body' | 'has-attachment';
  operator: 'contains' | 'equals' | 'starts-with' | 'ends-with' | 'matches';
  value: string;
}

export interface FilterAction {
  type: 'label' | 'archive' | 'delete' | 'star' | 'mark-read' | 'move';
  value?: string;
}

export interface Filter {
  id: number;
  accountId: number;
  name: string;
  conditions: FilterCondition[];
  actions: FilterAction[];
  isEnabled: boolean;
  isAiGenerated: boolean;
  sortOrder?: number;
}
