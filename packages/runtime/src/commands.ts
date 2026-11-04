export type RunCommand =
  | { type: 'approval.decide'; approvalId: string; decision: 'approve' | 'reject'; updatedInput?: unknown; message?: string }
  | { type: 'message'; text: string }
  | { type: 'cancel'; reason: string; graceSeconds: number }
  | { type: 'ping' }
