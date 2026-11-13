// Storage on SQLite (built into Node, no native dependency).
//
// Holds what the chain does not: receipts indexed from it, what each payment
// was for, agent and seller display names, and refused payment attempts.
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

/** An agent the owner has issued a mandate to. */
export interface AgentRecord {
  ruleId: number;
  name: string;
  /**
   * DEMO ONLY: the agent's signing key is kept here so the dashboard can send
   * the agent on a purchase. In production the agent holds its own key and
   * this service never sees it.
   */
  secret: string;
  token: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface SellerRecord {
  address: string;
  name: string;
  domain: string;
}

/** A payment the smart account refused. Nothing is recorded on chain for these. */
export interface DeclineRecord {
  id: number;
  at: string;
  ruleId: number;
  seller: string;
  token: string;
  amount: string;
  item: string;
  reason: string;
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
      CREATE TABLE IF NOT EXISTS agents (
        rule_id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        secret TEXT NOT NULL,
        token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sellers (
        address TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS declines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        rule_id INTEGER NOT NULL,
        seller TEXT NOT NULL,
        token TEXT NOT NULL,
        amount TEXT NOT NULL,
        item TEXT NOT NULL,
        reason TEXT NOT NULL
      );
    `);
  }

  // ---------- receipts ----------

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

  // ---------- agents ----------

  agents(): AgentRecord[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY rule_id").all() as unknown as {
      rule_id: number;
      name: string;
      secret: string;
      token: string;
      created_at: string;
      revoked_at: string | null;
    }[];
    return rows.map((row) => ({
      ruleId: row.rule_id,
      name: row.name,
      secret: row.secret,
      token: row.token,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    }));
  }

  agent(ruleId: number): AgentRecord | undefined {
    return this.agents().find((agent) => agent.ruleId === ruleId);
  }

  /** Adds an agent unless one with that rule id is already known. */
  addAgent(agent: Omit<AgentRecord, "revokedAt">): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO agents (rule_id, name, secret, token, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(agent.ruleId, agent.name, agent.secret, agent.token, agent.createdAt);
  }

  markRevoked(ruleId: number, at: string): void {
    this.db
      .prepare("UPDATE agents SET revoked_at = ? WHERE rule_id = ? AND revoked_at IS NULL")
      .run(at, ruleId);
  }

  // ---------- sellers ----------

  sellers(): SellerRecord[] {
    return this.db.prepare("SELECT * FROM sellers ORDER BY name").all() as unknown as SellerRecord[];
  }

  upsertSeller(seller: SellerRecord): void {
    this.db
      .prepare(
        `INSERT INTO sellers (address, name, domain) VALUES (?, ?, ?)
         ON CONFLICT (address) DO UPDATE SET name = excluded.name, domain = excluded.domain`,
      )
      .run(seller.address, seller.name, seller.domain);
  }

  // ---------- declines ----------

  addDecline(decline: Omit<DeclineRecord, "id">): void {
    this.db
      .prepare(
        `INSERT INTO declines (at, rule_id, seller, token, amount, item, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decline.at,
        decline.ruleId,
        decline.seller,
        decline.token,
        decline.amount,
        decline.item,
        decline.reason,
      );
  }

  declines(): DeclineRecord[] {
    const rows = this.db.prepare("SELECT * FROM declines ORDER BY id DESC").all() as unknown as {
      id: number;
      at: string;
      rule_id: number;
      seller: string;
      token: string;
      amount: string;
      item: string;
      reason: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      ruleId: row.rule_id,
      seller: row.seller,
      token: row.token,
      amount: row.amount,
      item: row.item,
      reason: row.reason,
    }));
  }
}
