export type ApprovalRecord = {
  ref: string;
  action: string;
  audience: string;
  digest: string;
  fields: string[];
  plaintext?: unknown;
  submitted: boolean;
};

export class LocalAuthority {
  private records = new Map<string, ApprovalRecord>();

  approve(record: Omit<ApprovalRecord, "submitted">): ApprovalRecord {
    const stored = { ...record, submitted: false };
    this.records.set(record.ref, stored);
    return stored;
  }

  markSubmitted(ref: string): void {
    const record = this.records.get(ref);
    if (record) record.submitted = true;
  }

  revokeLocal(ref: string): { network: boolean } {
    const record = this.records.get(ref);
    if (!record || !record.submitted) {
      this.records.delete(ref);
      return { network: false };
    }
    return { network: true };
  }

  get(ref: string): ApprovalRecord | undefined {
    return this.records.get(ref);
  }
}
