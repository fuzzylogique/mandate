// Helpers shared by the scripts in this folder.
import { contract, Keypair, Networks, rpc, xdr } from "@stellar/stellar-sdk";
import {
  authEntryAddress,
  signSmartAccountAuthEntry,
  type SmartAccountSigner,
} from "../packages/shared/src/smart-account.ts";

export const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = Networks.TESTNET;

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

export interface SmartAccountCall {
  /** Contract to call and the function on it. */
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  /** Classic account that submits the transaction and pays the fee. */
  feePayer: Keypair;
  /** Who signs on behalf of the smart account, and under which rule. */
  signer: SmartAccountSigner;
  contextRuleId: number;
}

/**
 * Calls a contract function that needs the smart account's authorization:
 * simulate, sign the account's auth entry, simulate again, submit.
 * Returns the transaction hash and the function's return value.
 */
export async function invokeAsSmartAccount(
  call: SmartAccountCall,
): Promise<{ txHash: string; result: xdr.ScVal }> {
  const server = new rpc.Server(RPC_URL);
  const tx = await contract.AssembledTransaction.build({
    contractId: call.contractId,
    method: call.method,
    args: call.args,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey: call.feePayer.publicKey(),
    parseResultXdr: (result: xdr.ScVal) => result,
  });

  const operation = tx.built?.operations[0];
  if (!operation || operation.type !== "invokeHostFunction") {
    throw new Error("Expected a single invokeHostFunction operation");
  }
  const expirationLedger = (await server.getLatestLedger()).sequence + 60;
  for (const entry of operation.auth ?? []) {
    if (authEntryAddress(entry) === call.signer.smartAccount) {
      signSmartAccountAuthEntry(
        entry,
        call.signer,
        [call.contextRuleId],
        expirationLedger,
        NETWORK_PASSPHRASE,
      );
    }
  }

  // Simulate again with the signature attached, so the footprint and fees
  // cover what __check_auth, the verifier and the policies read and write.
  await tx.simulate();

  const { signTransaction } = contract.basicNodeSigner(call.feePayer, NETWORK_PASSPHRASE);
  const sent = await tx.signAndSend({ signTransaction, force: true });
  const txHash = sent.sendTransactionResponse?.hash ?? "";
  return { txHash, result: sent.result as xdr.ScVal };
}
