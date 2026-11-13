// Helpers shared by the scripts in this folder.
import { Networks } from "@stellar/stellar-sdk";
import {
  invokeAsSmartAccount as invoke,
  type SmartAccountCall,
} from "../packages/shared/src/smart-account.ts";

export const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = Networks.TESTNET;

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

/** `invokeAsSmartAccount` against testnet. */
export function invokeAsSmartAccount(call: Omit<SmartAccountCall, "rpcUrl" | "networkPassphrase">) {
  return invoke({ ...call, rpcUrl: RPC_URL, networkPassphrase: NETWORK_PASSPHRASE });
}
