import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Account, Address, Asset, Keypair, Networks, Operation, StrKey, Transaction, TransactionBuilder, hash, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { authEntryAddress, externalSigner, signSmartAccountAuthEntry } from "@mandate/shared/smart-account";
import { formatAmount } from "@mandate/shared";
import type { PaymentNetwork, SpendingPeriod } from "@mandate/shared";
import { ServiceError, requireThat } from "./store.ts";

export interface StellarConfig {
  rpcUrl: string;
  horizonUrl: string;
  friendbotUrl: string;
  explorerUrl: string;
  smartAccountWasmHash?: string;
  verifier?: string;
  spendingLimitPolicy?: string;
  sellerRegistry?: string;
  verifiedSmartPolicy?: string;
  registryAdminSecret?: string;
  encryptionKey: string;
}
export function stellarConfig(env: NodeJS.ProcessEnv): StellarConfig {
  requireThat(env.PAYMENTS_ENCRYPTION_KEY && /^[a-fA-F0-9]{64}$/.test(env.PAYMENTS_ENCRYPTION_KEY), 503, "Set PAYMENTS_ENCRYPTION_KEY to a random 32-byte hex key. Run pnpm setup:payments.");
  return {
    rpcUrl: env.PAYMENTS_RPC_URL || env.RPC_URL || "https://soroban-testnet.stellar.org",
    horizonUrl: env.PAYMENTS_HORIZON_URL || "https://horizon-testnet.stellar.org",
    friendbotUrl: env.PAYMENTS_FRIENDBOT_URL || "https://friendbot.stellar.org",
    explorerUrl: env.PAYMENTS_EXPLORER_URL || "https://stellar.expert/explorer/testnet",
    smartAccountWasmHash: env.SMART_ACCOUNT_WASM_HASH || undefined,
    verifier: env.ED25519_VERIFIER_ID || undefined,
    spendingLimitPolicy: env.SPENDING_LIMIT_POLICY_ID || undefined,
    sellerRegistry: env.SELLER_REGISTRY_ID || undefined,
    verifiedSmartPolicy: env.VERIFIED_SELLER_POLICY_ID || env.PAYMENTS_VERIFIED_SMART_POLICY_ID || undefined,
    registryAdminSecret: env.PAYMENTS_REGISTRY_ADMIN_SECRET || undefined,
    encryptionKey: env.PAYMENTS_ENCRYPTION_KEY,
  };
}

/** The owner's default rule on every smart account. */
export const OWNER_RULE = 0;
/** Rolling window lengths in ledgers (about 5 seconds each). */
export const PERIOD_LEDGERS: Record<SpendingPeriod, number> = { day: 17_280, week: 120_960, month: 518_400 };

export interface ChainWallet { id: string; address: string; rail: "classic" | "blockchain"; paymentRuleId?: number }
export interface ChainReceipt { txHash: string; result?: string }
export interface ChainGateway {
  network: PaymentNetwork;
  treasury(id: string): ChainWallet;
  wallet(id: string): ChainWallet;
  secret(id: string, value: () => string): string;
  command<T>(id: string, input: unknown, work: () => Promise<T>): Promise<T>;
  balance(wallet: ChainWallet, currency?: string): Promise<bigint>;
  faucet(wallet: ChainWallet): Promise<ChainReceipt & { amount: string }>;
  deposit(id: string, wallet: ChainWallet, amount: bigint, currency?: string): Promise<ChainReceipt>;
  createAccount(id: string, treasury: ChainWallet): Promise<ChainWallet & ChainReceipt>;
  transfer(id: string, treasury: ChainWallet, source: ChainWallet, destination: string, amount: bigint, mandate?: { id: string; ruleId: number; signer: Keypair }, currency?: string): Promise<ChainReceipt>;
  /** Adds a rule that lets `signer` (a public key) spend under a limit, trusted stores only. */
  addMandate(id: string, treasury: ChainWallet, account: ChainWallet, input: { name: string; limit: bigint; period: SpendingPeriod; expiresAt: string; currency?: string; signer: string }): Promise<{ ruleId: number } & ChainReceipt>;
  revokeMandate(id: string, treasury: ChainWallet, account: ChainWallet, ruleId: number): Promise<ChainReceipt>;
  spent(account: ChainWallet, ruleId: number): Promise<bigint>;
  /** True if the seller registry lists this address (G or C) as a trusted store. */
  isTrusted(address: string): Promise<boolean>;
  registerStore(address: string, domain: string): Promise<ChainReceipt>;
  setLimit(id: string, treasury: ChainWallet, account: ChainWallet, ruleId: number, limit: bigint): Promise<ChainReceipt>;
  /** Signing key held in the vault: an account owner's key or a hosted shopper's key. */
  keypairFor(id: string): Keypair;
  ensureUsd(): Promise<{ tokenContract: string; issuer: string }>;
  hasTransaction(id: string): boolean;
  close(): void;
}

/** Real Stellar testnet transport. Signed envelopes are persisted before submission. */
export class StellarGateway implements ChainGateway {
  readonly network: PaymentNetwork;
  private config: StellarConfig;
  private db: DatabaseSync;
  private server: rpc.Server;
  private asset: Asset;
  private usdAsset: Asset;
  private key: Buffer;
  private queue: Promise<unknown> = Promise.resolve();
  private wasmHash?: string;

  constructor(path: string, config: StellarConfig) {
    this.config = config;
    this.key = Buffer.from(config.encryptionKey, "hex");
    requireThat(this.key.length === 32, 503, "Invalid payment encryption key");
    this.server = new rpc.Server(config.rpcUrl, { timeout: 20_000 });
    this.asset = Asset.native();
    this.wasmHash = config.smartAccountWasmHash;
    this.network = {
      id: "stellar:testnet", name: "Stellar testnet", rpcUrl: config.rpcUrl, horizonUrl: config.horizonUrl,
      currency: "XLM", tokenContract: this.asset.contractId(Networks.TESTNET),
      explorerUrl: config.explorerUrl.replace(/\/$/, ""),
      smartAccounts: !!(config.verifier && config.spendingLimitPolicy && config.smartAccountWasmHash),
      verifiedSmartAccounts: !!(config.sellerRegistry && config.registryAdminSecret && config.verifiedSmartPolicy && config.verifier && config.smartAccountWasmHash),
      mandates: !!(config.sellerRegistry && config.verifiedSmartPolicy && config.spendingLimitPolicy && config.verifier && config.smartAccountWasmHash),
      faucet: true,
    };
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS chain_vault (id TEXT PRIMARY KEY, address TEXT NOT NULL, rail TEXT NOT NULL, ciphertext TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chain_transactions (id TEXT PRIMARY KEY, hash TEXT NOT NULL, envelope TEXT NOT NULL, receipt TEXT);
      CREATE TABLE IF NOT EXISTS chain_commands (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS chain_lease (id INTEGER PRIMARY KEY CHECK(id=1), holder TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chain_configuration (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chain_owner_payment_rules (id TEXT PRIMARY KEY, rule_id INTEGER NOT NULL);
    `);
    // One process uses this database, so a lease left by a crash or a --watch restart is stale.
    this.db.exec("DELETE FROM chain_lease");
    // The issuer is stable for this encrypted vault, including process restarts.
    this.usdAsset = new Asset("USD", this.keypair("anchor:USD:issuer").publicKey());
    this.network.assets = [
      { currency: "XLM", tokenContract: this.network.tokenContract },
      { currency: "USD", code: "USD", issuer: this.usdAsset.getIssuer(), tokenContract: this.usdAsset.contractId(Networks.TESTNET) },
    ];
    const fingerprint = createHash("sha256").update(JSON.stringify({ network: this.network.id, token: this.network.tokenContract, verifier: config.verifier ?? null, spendingLimitPolicy: config.spendingLimitPolicy ?? null })).digest("hex");
    this.db.prepare("INSERT OR IGNORE INTO chain_configuration VALUES (1, ?)").run(fingerprint);
    const saved = this.db.prepare("SELECT fingerprint FROM chain_configuration WHERE id=1").get() as { fingerprint: string };
    if (saved.fingerprint !== fingerprint) {
      this.db.close();
      throw new ServiceError(503, "This database uses a different asset or policy configuration. Restore the original settings or choose a new PAYMENTS_CHAIN_DB.");
    }
  }
  async check(): Promise<void> {
    const network = await this.server.getNetwork();
    requireThat(network.passphrase === Networks.TESTNET, 503, "Payment RPC must be Stellar testnet; mainnet is not enabled");
    const horizonResponse = await fetch(this.config.horizonUrl, { signal: AbortSignal.timeout(20_000) });
    const horizon = await horizonResponse.json() as { network_passphrase?: string };
    requireThat(horizonResponse.ok && horizon.network_passphrase === Networks.TESTNET, 503, "Payment Horizon must use the same Stellar testnet network");
    if (this.network.smartAccounts) {
      requireThat(/^[a-fA-F0-9]{64}$/.test(this.wasmHash!), 503, "Invalid smart-account WASM hash");
      await Promise.all([this.server.getContractWasmByHash(this.wasmHash!, "hex"), this.server.getContractInstance(this.config.verifier!), this.server.getContractInstance(this.config.spendingLimitPolicy!)]);
    }
    if (this.config.sellerRegistry) {
      await this.server.getContractInstance(this.config.sellerRegistry);
      if (this.config.registryAdminSecret) {
        const admin = await this.readContract<string>(this.config.sellerRegistry, "admin", []);
        requireThat(admin === Keypair.fromSecret(this.config.registryAdminSecret).publicKey(), 503, "PAYMENTS_REGISTRY_ADMIN_SECRET does not match the seller registry admin");
      }
    }
    if (this.config.verifiedSmartPolicy) await this.server.getContractInstance(this.config.verifiedSmartPolicy);
    // Opening an existing vault with a different key must fail before serving requests.
    const existing = this.db.prepare("SELECT id,ciphertext FROM chain_vault WHERE ciphertext<>'' LIMIT 1").get() as { id: string; ciphertext: string } | undefined;
    if (existing) this.decrypt(existing.ciphertext, existing.id);
  }
  close() { this.db.close(); }
  private encrypt(secret: string, id: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
  }
  private decrypt(ciphertext: string, id: string): string {
    const bytes = Buffer.from(ciphertext, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  }
  secret(id: string, generate: () => string): string {
    const row = this.db.prepare("SELECT ciphertext FROM chain_vault WHERE id=?").get(id) as { ciphertext: string } | undefined;
    if (row) return this.decrypt(row.ciphertext, id);
    const value = generate();
    this.db.prepare("INSERT INTO chain_vault VALUES (?, '', 'classic', ?)").run(id, this.encrypt(value, id));
    return value;
  }
  private keypair(id: string): Keypair { return Keypair.fromSecret(this.secret(id, () => Keypair.random().secret())); }
  keypairFor(id: string): Keypair { return this.keypair(id); }
  treasury(id: string): ChainWallet {
    const key = this.keypair(id);
    this.db.prepare("UPDATE chain_vault SET address=? WHERE id=? AND address=''").run(key.publicKey(), id);
    return { id, address: key.publicKey(), rail: "classic" };
  }
  wallet(id: string): ChainWallet {
    const row = this.db.prepare("SELECT address,rail FROM chain_vault WHERE id=?").get(id) as { address: string; rail: ChainWallet["rail"] } | undefined;
    requireThat(row?.address, 409, "Account does not have a wallet on this network. Create a new chain account.");
    return { id, ...row };
  }
  command<T>(id: string, input: unknown, work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const existing = this.db.prepare("SELECT fingerprint,result FROM chain_commands WHERE id=?").get(id) as { fingerprint: string; result: string | null } | undefined;
      requireThat(!existing || existing.fingerprint === fingerprint, 409, "Idempotency key was used with different details");
      if (existing?.result) return JSON.parse(this.decrypt(existing.result, `command:${id}`)) as T;
      const holder = randomBytes(16).toString("hex");
      this.db.prepare("INSERT INTO chain_lease VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET holder=excluded.holder, expires=excluded.expires WHERE chain_lease.expires < ?").run(holder, Date.now() + 600_000, Date.now());
      const lease = this.db.prepare("SELECT holder FROM chain_lease WHERE id=1").get() as { holder: string };
      requireThat(lease.holder === holder, 503, "Another payment operation is running. Retry with the same request ID.");
      try {
        this.db.prepare("INSERT OR IGNORE INTO chain_commands (id,fingerprint) VALUES (?,?)").run(id, fingerprint);
        const result = await work();
        this.db.prepare("UPDATE chain_commands SET result=? WHERE id=?").run(this.encrypt(JSON.stringify(result ?? null), `command:${id}`), id);
        return result;
      } finally { this.db.prepare("DELETE FROM chain_lease WHERE id=1 AND holder=?").run(holder); }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async nativeBalance(address: string): Promise<bigint> {
    const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrPublicKey() }));
    const result = await this.server.getLedgerEntries(key);
    return BigInt(result.entries[0]?.val.account().balance().toString() ?? "0");
  }
  private paymentAsset(currency = "XLM"): Asset {
    requireThat(currency === "XLM" || currency === "USD", 400, "Unsupported payment currency");
    return currency === "USD" ? this.usdAsset : this.asset;
  }
  async balance(wallet: ChainWallet, currency = "XLM"): Promise<bigint> {
    const asset = this.paymentAsset(currency);
    if (wallet.rail === "classic" && asset.isNative()) return this.nativeBalance(wallet.address);
    const balance = await this.server.getAssetBalance(wallet.address, asset, Networks.TESTNET);
    return BigInt(balance.balanceEntry?.amount ?? "0");
  }
  async faucet(wallet: ChainWallet): Promise<ChainReceipt & { amount: string }> {
    const before = await this.nativeBalance(wallet.address);
    let txHash: string;
    let credited: string | undefined;
    if (before === 0n) {
      const url = new URL(this.config.friendbotUrl); url.searchParams.set("addr", wallet.address);
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const result = await response.json() as { hash?: string; detail?: string };
      requireThat(response.ok && result.hash, 409, result.detail ?? "Friendbot could not activate this account");
      txHash = result.hash;
    } else {
      // Recover an activation that confirmed before the original HTTP response arrived.
      const url = new URL(`${this.config.horizonUrl.replace(/\/$/, "")}/accounts/${wallet.address}/operations`);
      url.searchParams.set("order", "asc"); url.searchParams.set("limit", "1");
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const result = await response.json() as { _embedded?: { records?: { type: string; account: string; transaction_hash: string; starting_balance: string }[] } };
      const creation = result._embedded?.records?.[0];
      requireThat(response.ok && creation?.type === "create_account" && creation.account === wallet.address, 409, "This wallet is already active. Deposit testnet funds directly to its address.");
      txHash = creation.transaction_hash;
      credited = creation.starting_balance;
    }
    const after = await this.nativeBalance(wallet.address);
    return { txHash, amount: credited ?? formatAmount((after - before).toString()) };
  }
  /** Testnet funding provider: credit the selected amount to the hidden Classic wallet. */
  async deposit(id: string, wallet: ChainWallet, units: bigint, currency = "XLM"): Promise<ChainReceipt> {
    if (currency === "USD") return this.depositUsd(id, wallet, units);
    this.paymentAsset(currency);
    const transactionId = `deposit:${id}`;
    const source = this.treasury(`funding-source:${id}`);
    // The source and signed deposit are persistent, so a retry cannot issue a second credit.
    if (!this.hasTransaction(transactionId)) {
      await this.faucet(source);
      requireThat(await this.balance(source) >= units + 20_000_000n, 400, "Amount exceeds the available testnet funding allowance");
    }
    return this.transfer(transactionId, source, source, wallet.address, units);
  }
  async ensureUsd(): Promise<{ tokenContract: string; issuer: string }> {
    await this.ensureUsdAsset();
    return { tokenContract: this.usdAsset.contractId(Networks.TESTNET), issuer: this.usdAsset.getIssuer()! };
  }
  private async ensureUsdAsset(): Promise<void> {
    const issuer = this.treasury("anchor:USD:issuer");
    // Check for an existing SAC before deployment, including after a restart.
    const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
      contract: Address.fromString(this.usdAsset.contractId(Networks.TESTNET)).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent(),
    }));
    if ((await this.server.getLedgerEntries(key)).entries.length) return;
    await this.faucet(issuer);
    await this.execute("anchor:USD:asset", () => this.contract(this.keypair(issuer.id), Operation.createStellarAssetContract({ asset: this.usdAsset })));
  }
  private async depositUsd(id: string, wallet: ChainWallet, units: bigint): Promise<ChainReceipt> {
    requireThat(wallet.rail === "classic", 400, "Demo deposits require the mapped Classic wallet");
    await this.ensureUsdAsset();
    const issuer = this.treasury("anchor:USD:issuer");
    if (await this.nativeBalance(issuer.address) === 0n) await this.faucet(issuer);
    return this.execute(`deposit:${id}`, () => this.classic(this.keypair(issuer.id), [
      // Setting the same trust limit is safe for subsequent deposits.
      Operation.changeTrust({ source: wallet.address, asset: this.usdAsset }),
      Operation.payment({ destination: wallet.address, asset: this.usdAsset, amount: formatAmount(units.toString()) }),
    ], [this.keypair(wallet.id)]));
  }
  private async classic(payer: Keypair, operations: xdr.Operation[], extraSigners: Keypair[] = []): Promise<Transaction> {
    const account = await this.server.getAccount(payer.publicKey());
    const builder = new TransactionBuilder(account, { fee: "10000", networkPassphrase: Networks.TESTNET });
    for (const operation of operations) builder.addOperation(operation);
    const tx = builder.setTimeout(180).build(); tx.sign(payer, ...extraSigners);
    return tx;
  }
  private async contract(payer: Keypair, operation: xdr.Operation, smart?: { wallet: ChainWallet; signer: Keypair; ruleId: number }): Promise<Transaction> {
    const account = await this.server.getAccount(payer.publicKey());
    const sequence = account.sequenceNumber();
    const build = (op: xdr.Operation) => new TransactionBuilder(new Account(account.accountId(), sequence), { fee: "10000", networkPassphrase: Networks.TESTNET }).addOperation(op).setTimeout(180).build();
    let tx = build(operation);
    if (smart) {
      const simulation = await this.server.simulateTransaction(tx);
      requireThat(!rpc.Api.isSimulationError(simulation) && simulation.result, 409, "Contract rejected the transaction during simulation");
      const expiration = (await this.server.getLatestLedger()).sequence + 30;
      const auth = simulation.result.auth ?? [];
      for (const entry of auth) if (authEntryAddress(entry) === smart.wallet.address) signSmartAccountAuthEntry(entry, { smartAccount: smart.wallet.address, verifier: this.config.verifier!, keypair: smart.signer }, [smart.ruleId], expiration, Networks.TESTNET);
      const invocation = operation.body().invokeHostFunctionOp();
      tx = build(Operation.invokeHostFunction({ func: invocation.hostFunction(), auth }));
    }
    const prepared = await this.server.prepareTransaction(tx);
    requireThat(BigInt(prepared.fee) <= 100_000_000n, 409, "Transaction fee exceeds the 10 XLM testnet ceiling");
    prepared.sign(payer);
    return prepared;
  }
  /** Reuse the identical signed envelope after timeouts or process restarts. */
  private async execute(id: string, build: () => Promise<Transaction>): Promise<ChainReceipt> {
    let saved = this.db.prepare("SELECT hash,envelope,receipt FROM chain_transactions WHERE id=?").get(id) as { hash: string; envelope: string; receipt: string | null } | undefined;
    if (saved?.receipt) return JSON.parse(saved.receipt) as ChainReceipt;
    if (!saved) {
      const tx = await build();
      saved = { hash: tx.hash().toString("hex"), envelope: tx.toXDR(), receipt: null };
      this.db.prepare("INSERT INTO chain_transactions(id,hash,envelope) VALUES (?,?,?)").run(id, saved.hash, saved.envelope);
    }
    const tx = TransactionBuilder.fromXDR(saved.envelope, Networks.TESTNET);
    let result = await this.server.getTransaction(saved.hash);
    if (result.status === "NOT_FOUND") {
      const submitted = await this.server.sendTransaction(tx);
      // ERROR can mean an earlier submission already consumed this sequence;
      // always query the original hash before deciding the outcome.
      if (submitted.status === "ERROR") {
        result = await this.server.getTransaction(saved.hash);
        if (result.status !== "SUCCESS") {
          // Rejected or past its time bound: it can never land, so let the next retry rebuild it.
          this.forget(id);
          throw new ServiceError(409, `Transaction was rejected or expired (${saved.hash}). Retry with the same request ID.`);
        }
      }
    }
    for (let count = 0; count < 40; count++) {
      if (result.status === "SUCCESS") {
        const receipt: ChainReceipt = { txHash: saved.hash, result: result.returnValue?.toXDR("base64") };
        this.db.prepare("UPDATE chain_transactions SET receipt=? WHERE id=?").run(JSON.stringify(receipt), id);
        return receipt;
      }
      if (result.status === "FAILED") {
        this.forget(id);
        throw new ServiceError(409, `Stellar transaction failed (${saved.hash})`);
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
      result = await this.server.getTransaction(saved.hash);
    }
    throw new ServiceError(503, `Transaction is awaiting confirmation (${saved.hash}). Retry with the same request ID.`, saved.hash);
  }
  private forget(id: string) { this.db.prepare("DELETE FROM chain_transactions WHERE id=? AND receipt IS NULL").run(id); }
  hasTransaction(id: string): boolean { return !!this.db.prepare("SELECT id FROM chain_transactions WHERE id=?").get(id); }
  async createAccount(id: string, treasury: ChainWallet): Promise<ChainWallet & ChainReceipt> {
    const payer = this.keypair(treasury.id);
    requireThat(this.network.smartAccounts && this.wasmHash, 503, "Configure smart-account WASM, verifier and spending-limit policy before creating smart accounts");
    const receipt = await this.execute(`create:${id}`, () => this.contract(payer, Operation.createCustomContract({
      address: Address.fromString(payer.publicKey()), wasmHash: Buffer.from(this.wasmHash!, "hex"), salt: hash(Buffer.from(id)),
      constructorArgs: [nativeToScVal("owner", { type: "string" }), xdr.ScVal.scvVec([externalSigner(this.config.verifier!, payer)]), xdr.ScVal.scvMap([])],
    })));
    requireThat(receipt.result, 502, "Deployment did not return a contract address");
    const address = Address.fromScVal(xdr.ScVal.fromXDR(receipt.result, "base64")).toString();
    this.db.prepare("INSERT OR IGNORE INTO chain_vault VALUES (?, ?, 'blockchain', '')").run(id, address);
    return { id, address, rail: "blockchain", ...receipt };
  }
  private async readContract<T>(contract: string, method: string, args: xdr.ScVal[]): Promise<T> {
    return scValToNative(await this.readRaw(contract, method, args)) as T;
  }
  private async readRaw(contract: string, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
    const source = Keypair.random();
    const tx = new TransactionBuilder(new Account(source.publicKey(), "0"), { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.invokeContractFunction({ contract, function: method, args })).setTimeout(30).build();
    const simulation = await this.server.simulateTransaction(tx);
    requireThat(!rpc.Api.isSimulationError(simulation) && simulation.result, 503, `Could not read ${method} from the contract`);
    return simulation.result.retval;
  }
  async isTrusted(address: string): Promise<boolean> {
    if (!this.config.sellerRegistry || !(StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address))) return false;
    return this.readContract<boolean>(this.config.sellerRegistry, "is_verified", [Address.fromString(address).toScVal()]);
  }
  /** Records a store's payment address against its domain. Registry admin only. */
  registerStore(address: string, domain: string): Promise<ChainReceipt> {
    requireThat(this.config.sellerRegistry && this.config.registryAdminSecret, 503, "Configure the seller registry and its admin key");
    const admin = Keypair.fromSecret(this.config.registryAdminSecret);
    return this.execute(`register-store:${address}:${domain}`, () => this.contract(admin, Operation.invokeContractFunction({
      contract: this.config.sellerRegistry!, function: "register", args: [Address.fromString(address).toScVal(), nativeToScVal(domain, { type: "string" })],
    })));
  }
  async transfer(id: string, treasury: ChainWallet, source: ChainWallet, destination: string, units: bigint, mandate?: { id: string; ruleId: number; signer: Keypair }, currency = "XLM"): Promise<ChainReceipt> {
    const asset = this.paymentAsset(currency);
    requireThat(StrKey.isValidEd25519PublicKey(destination) || StrKey.isValidContract(destination), 400, "Enter a valid Stellar recipient address");
    const payer = this.keypair(treasury.id);
    if (source.rail === "classic" && destination.startsWith("G")) {
      return this.execute(id, () => this.classic(payer, [Operation.payment({ source: source.address, destination, asset, amount: formatAmount(units.toString()) })], source.id === treasury.id ? [] : [this.keypair(source.id)]));
    }
    return this.execute(id, async () => {
      const op = Operation.invokeContractFunction({ contract: asset.contractId(Networks.TESTNET), function: "transfer", args: [Address.fromString(source.address).toScVal(), Address.fromString(destination).toScVal(), nativeToScVal(units, { type: "i128" })] });
      if (source.rail === "blockchain") {
        // Under a mandate, the mandate's own key signs against its rule, so the
        // account's policies check the payment. Without one, the owner signs rule 0.
        return this.contract(payer, op, mandate ? { wallet: source, signer: mandate.signer, ruleId: mandate.ruleId } : { wallet: source, signer: payer, ruleId: OWNER_RULE });
      }
      // Classic sources used through SAC require their address authorization in addition to fee sponsorship.
      requireThat(source.id === treasury.id, 400, "The linked Classic wallet must authorize and pay fees for Smart Account funding");
      return this.contract(payer, op);
    });
  }
  async addMandate(id: string, treasury: ChainWallet, account: ChainWallet, input: { name: string; limit: bigint; period: SpendingPeriod; expiresAt: string; currency?: string; signer: string }): Promise<{ ruleId: number } & ChainReceipt> {
    requireThat(this.config.sellerRegistry && this.config.verifiedSmartPolicy, 503, "Configure the verified-seller policy and registry before creating mandates");
    requireThat(StrKey.isValidEd25519PublicKey(input.signer), 400, "The shopper key must be a Stellar public key");
    const signer = Keypair.fromPublicKey(input.signer);
    const payer = this.keypair(treasury.id);
    const latest = await this.server.getLatestLedger();
    const tokenContract = this.paymentAsset(input.currency).contractId(Networks.TESTNET);
    const expiry = latest.sequence + Math.max(1, Math.floor((Date.parse(input.expiresAt) - Date.now()) / 5000));
    const params = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("period_ledgers"), val: xdr.ScVal.scvU32(PERIOD_LEDGERS[input.period]) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("spending_limit"), val: nativeToScVal(input.limit, { type: "i128" }) }),
    ]);
    // Rule labels are contract-limited to 20 UTF-8 bytes; the complete name remains in the workspace.
    let label = input.name;
    while (Buffer.byteLength(label) > 20) label = [...label].slice(0, -1).join("");
    const registryParams = xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("registry"), val: Address.fromString(this.config.sellerRegistry!).toScVal() })]);
    const policies = [{ address: this.config.spendingLimitPolicy!, params }, { address: this.config.verifiedSmartPolicy!, params: registryParams }]
      .sort((a, b) => Buffer.compare(Address.fromString(a.address).toBuffer(), Address.fromString(b.address).toBuffer()));
    const args = [xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("CallContract"), Address.fromString(tokenContract).toScVal()]), nativeToScVal(label, { type: "string" }), xdr.ScVal.scvU32(expiry), xdr.ScVal.scvVec([externalSigner(this.config.verifier!, signer)]), xdr.ScVal.scvMap(policies.map(policy => new xdr.ScMapEntry({ key: Address.fromString(policy.address).toScVal(), val: policy.params })))];
    const receipt = await this.execute(`mandate:${id}`, () => this.contract(payer, Operation.invokeContractFunction({ contract: account.address, function: "add_context_rule", args }), { wallet: account, signer: payer, ruleId: OWNER_RULE }));
    requireThat(receipt.result, 502, "Mandate creation did not return a rule");
    const result = scValToNative(xdr.ScVal.fromXDR(receipt.result, "base64")) as { id: number };
    return { ...receipt, ruleId: result.id };
  }
  /** Changes a mandate's limit on-chain. The owner signs; the policy keeps its spending history. */
  async setLimit(id: string, treasury: ChainWallet, account: ChainWallet, ruleId: number, limit: bigint): Promise<ChainReceipt> {
    const payer = this.keypair(treasury.id);
    const rule = await this.readRaw(account.address, "get_context_rule", [xdr.ScVal.scvU32(ruleId)]);
    return this.execute(`limit:${id}`, () => this.contract(payer, Operation.invokeContractFunction({
      contract: this.config.spendingLimitPolicy!, function: "set_spending_limit",
      args: [nativeToScVal(limit, { type: "i128" }), rule, Address.fromString(account.address).toScVal()],
    }), { wallet: account, signer: payer, ruleId: OWNER_RULE }));
  }
  revokeMandate(id: string, treasury: ChainWallet, account: ChainWallet, ruleId: number): Promise<ChainReceipt> {
    const payer = this.keypair(treasury.id);
    return this.execute(`revoke:${id}`, () => this.contract(payer, Operation.invokeContractFunction({ contract: account.address, function: "remove_context_rule", args: [xdr.ScVal.scvU32(ruleId)] }), { wallet: account, signer: payer, ruleId: OWNER_RULE }));
  }
  async spent(account: ChainWallet, ruleId: number): Promise<bigint> {
    // A read-only simulation uses a synthetic source; no fees or signature are needed.
    const source = Keypair.random();
    const tx = new TransactionBuilder(new Account(source.publicKey(), "0"), { fee: "100", networkPassphrase: Networks.TESTNET }).addOperation(Operation.invokeContractFunction({ contract: this.config.spendingLimitPolicy!, function: "get_spending_limit_data", args: [xdr.ScVal.scvU32(ruleId), Address.fromString(account.address).toScVal()] })).setTimeout(30).build();
    const simulation = await this.server.simulateTransaction(tx);
    requireThat(!rpc.Api.isSimulationError(simulation) && simulation.result, 503, "Could not read the on-chain mandate limit");
    const data = scValToNative(simulation.result.retval) as { period_ledgers: number; spending_history: { amount: bigint; ledger_sequence: number }[] };
    const latest = await this.server.getLatestLedger();
    return data.spending_history.filter(e => e.ledger_sequence > latest.sequence - data.period_ledgers).reduce((sum, e) => sum + e.amount, 0n);
  }
}
