# LangChain payment agent and tool

A standalone TypeScript module using LangChain's [`tool`](https://reference.langchain.com/javascript/langchain-core/tools/tool) API.
Both the agent and direct tool call `POST /api/pay` without an owner login.

`mandateId` is the secret mandate ID revealed in the dashboard. `agentId` is the public identification value from the **Agents** tab, registered on chain to the mandate’s source account. `sellerId` is
the seller's verified Smart Account **C address**, copied from their dashboard;
the API has no separate seller-ID lookup. The server validates the mandate,
recipient, balance and spending limits and settles demo USD on Stellar testnet.

## Prompt-driven agent

The agent uses LangChain's [`createAgent`](https://docs.langchain.com/oss/javascript/langchain/agents)
with [`ChatGoogle`](https://docs.langchain.com/oss/javascript/integrations/chat/google).
The default model is [`gemini-3.8-flash`](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).
Add your API key to the repository's ignored `.env`:

```dotenv
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.8-flash
# Optional; defaults to http://localhost:4022
PAYMENTS_API_URL=http://localhost:4022
```

With dependencies installed (`pnpm install`) and the payments service running
(`pnpm dev:receipts`), start the agent from the repository root:

```bash
pnpm agent:langchain
```

At `You:`, type a payment request containing all four details:

```text
Pay 0.2 USD to seller C_REPLACE_WITH_SELLER_SMART_ACCOUNT_ADDRESS using mandate mnd_replace_with_secret and agent identification agt_replace_with_identification
```

The agent extracts the details, calls the payment tool and prints the API result.
It asks follow-up questions if details are missing. Type `exit` to quit; the
session ends after one payment result. Prompts, including the mandate ID, are
sent to the configured Gemini model. The agent is instructed to omit the secret
from its replies.

You can also pass a prompt directly and override the model or request ID:

```bash
pnpm agent:langchain --prompt "Pay 0.2 USD to seller C_REPLACE_WITH_SELLER_SMART_ACCOUNT_ADDRESS using mandate mnd_replace_with_secret and agent identification agt_replace_with_identification"
pnpm agent:langchain --model "gemini-3.8-flash" --request-id "purchase-001"
```

The CLI generates and prints a request ID before running the agent. For pending
or uncertain outcomes, rerun with `--request-id` set to that ID and the **same
mandate, agent identification, seller, amount and reference**. Each session permits only one set of
payment details; repeated tool calls reuse the first attempt without sending
another request. An omitted reference defaults to `LangChain payment`.

The model comes from `--model`, then `GEMINI_MODEL`, then the default. Unlike the
direct CLI, the agent takes payment details from your conversation rather than
`MANDATE_ID`, `AGENT_ID`, `SELLER_ID`, `PAYMENT_AMOUNT`, `PAYMENT_REFERENCE`, or
`PAYMENT_REQUEST_ID`. Use `--request-id` to choose the agent's request ID.

Temporary Gemini errors (including high demand / HTTP 503) trigger up to two
retries with backoff. These retries apply to model requests; payment submissions
are still sent at most once per session. If Gemini remains unavailable, the CLI
reports whether a payment was attempted and prints a command to restart with the
same request ID. You can choose another model, such as
[`gemini-3.5-flash-lite`](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite),
with `--model` or `GEMINI_MODEL`.

For embedding, import `createPaymentAgent` from `@mandate/langchain/agent` and
invoke `session.agent.invoke({ messages: [{ role: "user", content: prompt }] })`.
Read `session.paymentResult` for the API outcome and `session.requestId` for retries.

## Direct CLI and tool

The direct CLI does not call a model and needs no Gemini API key.

From the repository root, install dependencies with `pnpm install`, start the
payment service with `pnpm dev:receipts`, then run:

```bash
pnpm pay:langchain --mandate-id "mnd_replace_with_secret" --agent-id "agt_replace_with_identification" --seller-id "C_REPLACE_WITH_SELLER_SMART_ACCOUNT_ADDRESS" --amount "0.10"
```

These flags override `MANDATE_ID`, `AGENT_ID`, `SELLER_ID` and `PAYMENT_AMOUNT` in `.env`.
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
  agentId: process.env.AGENT_ID!,
  sellerId: process.env.SELLER_ID!,
});

const result = await pay.invoke({
  amount: "0.10",
  reference: "Example purchase",
  requestId: "example-purchase-001",
});
```

When embedding this direct tool in your own agent, the mandate ID, agent identification and seller are
bound in the factory; the model only supplies amount, reference and request ID.
This lets you keep the secret outside your model's prompts. The prompt-driven
agent above instead accepts the IDs in the conversation.
