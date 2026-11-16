# LangChain payment tool

A standalone TypeScript module using LangChain's [`tool`](https://reference.langchain.com/javascript/langchain-core/tools/tool) API.
It calls `POST /api/pay` without an owner login or an LLM API key.

`mandateId` is the secret mandate ID revealed in the dashboard. `sellerId` is
the seller's verified Smart Account **C address**, copied from their dashboard;
the API has no separate seller-ID lookup. The server validates the mandate,
recipient, balance and spending limits and settles demo USD on Stellar testnet.

From the repository root, install dependencies with `pnpm install`, start the
payment service with `pnpm dev:receipts`, then run:

```bash
pnpm pay:langchain --mandate-id "mnd_replace_with_secret" --seller-id "C_REPLACE_WITH_SELLER_SMART_ACCOUNT_ADDRESS" --amount "0.10"
```

These flags override `MANDATE_ID`, `SELLER_ID` and `PAYMENT_AMOUNT` in `.env`.
You can omit any flag if its corresponding environment variable is set.
Run `pnpm pay:langchain --help` to see usage.

The reference defaults to `LangChain payment` and the request ID defaults to a
new UUID. You can set them with `--reference "Example purchase"` and
`--request-id "example-purchase-001"`, or with `PAYMENT_REFERENCE` and
`PAYMENT_REQUEST_ID` in `.env`. Flags take precedence. Optionally set
`PAYMENTS_API_URL` in `.env` to change the service origin from `http://localhost:4022`.

The command prints the API's `paid`, `declined`, or `pending` result. Reuse the
same request ID and payment details when retrying a pending payment or a network
failure: the CLI prints the request ID before submitting, so pass that value with
`--request-id` on retry. Running again without a fixed request ID generates a new
payment request. Use a new request ID only for a new payment. The tool sends one request
per invocation and leaves retries to the caller.

You can also import the tool into another workspace package (add
`"@mandate/langchain": "workspace:*"` to that package's dependencies):

```ts
import { createPayTool } from "@mandate/langchain";

const pay = createPayTool({
  mandateId: process.env.MANDATE_ID!,
  sellerId: process.env.SELLER_ID!,
});

const result = await pay.invoke({
  amount: "0.10",
  reference: "Example purchase",
  requestId: "example-purchase-001",
});
```

The returned tool can be supplied to a LangChain agent. The mandate ID and seller
are bound in the factory; the model only supplies amount, reference and request
ID. Keep the secret mandate ID out of prompts and logs.
