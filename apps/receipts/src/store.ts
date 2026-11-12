// Receipt storage on SQLite (built into Node, no native dependency).
import { DatabaseSync } from "node:sqlite";
import type { Receipt, ReceiptAnnotation } from "@mandate/shared";

interface ReceiptRow {
  id: string;
  tx_hash: string;
  ledger: number;
  paid_at: string;
  smart_account: string;
  context_rule_id: number;
  seller: string;
  token: string;
  amount: string;
  annotation: string | null;
}

export class ReceiptStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY,
        tx_hash TEXT NOT NULL,
        ledger INTEGER NOT NULL,
        paid_at TEXT NOT NULL,
        smart_account TEXT NOT NULL,
        context_rule_id INTEGER NOT NULL,
        seller TEXT NOT NULL,
        token TEXT NOT NULL,
        amount TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS receipts_by_account ON receipts (smart_account, ledger);
      CREATE TABLE IF NOT EXISTS annotations (
        tx_hash TEXT PRIMARY KEY,
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL
      );
    `);
  }

  /** Returns true if the receipt is new. */
  insert(receipt: Omit<Receipt, "annotation">): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO receipts
           (id, tx_hash, ledger, paid_at, smart_account, context_rule_id, seller, token, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.id,
        receipt.txHash,
        receipt.ledger,
        receipt.paidAt,
        receipt.smartAccount,
        receipt.contextRuleId,
        receipt.seller,
        receipt.token,
        receipt.amount,
      );
    return result.changes > 0;
  }

  annotate(annotation: ReceiptAnnotation): void {
    this.db
      .prepare(
        `INSERT INTO annotations (tx_hash, body) VALUES (?, ?)
         ON CONFLICT (tx_hash) DO UPDATE SET body = excluded.body`,
      )
      .run(annotation.txHash, JSON.stringify(annotation));
  }

  list(smartAccount?: string): Receipt[] {
    const sql = `
      SELECT r.*, a.body AS annotation
      FROM receipts r LEFT JOIN annotations a ON a.tx_hash = r.tx_hash
      ${smartAccount ? "WHERE r.smart_account = ?" : ""}
      ORDER BY r.ledger DESC, r.id DESC`;
    const statement = this.db.prepare(sql);
    const rows = (smartAccount ? statement.all(smartAccount) : statement.all()) as unknown as ReceiptRow[];
    return rows.map((row) => ({
      id: row.id,
      txHash: row.tx_hash,
      ledger: row.ledger,
      paidAt: row.paid_at,
      smartAccount: row.smart_account,
      contextRuleId: row.context_rule_id,
      seller: row.seller,
      token: row.token,
      amount: row.amount,
      annotation: row.annotation ? (JSON.parse(row.annotation) as ReceiptAnnotation) : null,
    }));
  }

  getCursor(): string | undefined {
    const row = this.db.prepare("SELECT value FROM cursor WHERE id = 1").get() as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setCursor(value: string): void {
    this.db
      .prepare(
        `INSERT INTO cursor (id, value) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET value = excluded.value`,
      )
      .run(value);
  }
}
