export interface ToolActivityOrderEntry {
  id: string;
  kind: 'tool-call' | 'tool-message';
}
