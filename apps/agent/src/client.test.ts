import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Address, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";
import { checkTransfer, MandateAgent } from "./client.ts";

const contract = () => StrKey.encodeContract(randomBytes(32));
function entry(token: string, from: string, to: string, amount: bigint, fn = "transfer", sub: xdr.SorobanAuthorizedInvocation[] = []) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
      address: Address.fromString(from).toScAddress(), nonce: xdr.Int64.fromString("7"), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid(),
    })),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(token).toScAddress(), functionName: fn,
        args: [Address.fromString(from).toScVal(), Address.fromString(to).toScVal(), nativeToScVal(amount, { type: "i128" })],
      })),
      subInvocations: sub,
    }),
  });
}

test("the agent signs only the exact transfer it asked for", () => {
  const token = contract(); const account = contract(); const seller = contract();
  const expected = { token, from: account, to: seller, amount: 25_000_000n };
  checkTransfer(entry(token, account, seller, 25_000_000n), expected);
  assert.throws(() => checkTransfer(entry(token, account, contract(), 25_000_000n), expected), /not the one/);
  assert.throws(() => checkTransfer(entry(token, account, seller, 25_000_001n), expected), /not the one/);
  assert.throws(() => checkTransfer(entry(contract(), account, seller, 25_000_000n), expected), /not the one/);
  assert.throws(() => checkTransfer(entry(token, account, seller, 25_000_000n, "approve"), expected), /not the one/);
  assert.throws(() => checkTransfer(entry(token, contract(), seller, 25_000_000n), expected), /different account/);
  const extra = entry(token, account, seller, 1n).rootInvocation();
  assert.throws(() => checkTransfer(entry(token, account, seller, 25_000_000n, "transfer", [extra]), expected), /other calls/);
});

test("the key is created once, kept private, and reused", () => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-agent-"));
  try {
    const file = join(directory, "agent.json");
    const first = new MandateAgent({ file, apiUrl: "http://127.0.0.1:9" });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(new MandateAgent({ file }).publicKey, first.publicKey);
    assert.equal(readFileSync(file, "utf8").includes(first.publicKey), false, "only the secret is stored; the public key is derived");
    assert.throws(() => first.mandates(), /Not connected/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
