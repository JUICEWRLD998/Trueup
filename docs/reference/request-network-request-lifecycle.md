> ## Documentation Index
> Fetch the complete documentation index at: https://docs.request.network/llms.txt
> Use this file to discover all available pages before exploring further.

# Lifecycle of a Request

> The typical lifecycle of a request is as follows:

<Frame caption="Typical Lifecycle of a Request">
  <img src="https://mintcdn.com/requestnetwork/fSZ-6OwMf7IoNi7s/images/architecture/lifecycle-of-a-request/request-lifecycle.webp?fit=max&auto=format&n=fSZ-6OwMf7IoNi7s&q=85&s=c349eabb5635736bd8624859cef28a79" alt="Typical Lifecycle of a Request" width="1920" height="1080" data-path="images/architecture/lifecycle-of-a-request/request-lifecycle.webp" />
</Frame>

## Create a request

* The payer or payee signs the request which contains the payee, payer, currency, amount, payment details, and arbitrary content data.
* The request can be optionally encrypted such that only the payee, payer, and approved 3rd parties can view the request contents.
* The request is persisted in IPFS.
* The IPFS Content-addressable ID (CID) is stored in a smart contract on Gnosis chain

<Info>
  Requests are *created* by storing their CIDs on Gnosis, but this doesn't mean *payment* must occur on Gnosis. *Payment* can occur on any of the supported chains — EVM-compatible chains and Tron.
</Info>

## Update a request

* The payee can optionally cancel the request or increase/decrease the expected amount.
* The payer can optionally accept the request, indicating that they intend to pay it.
* Both payee and payer can add third-party stakeholders if the request is encrypted.

## Pay a request

* The payer derives a paymentReference from the request contents.
* The payer calls a function on the payment network smart contract, passing in the token address, to address, amount, and paymentReference.
* An event is emitted containing the token address, to address, amount, and paymentReference.

<Info>
  Most requests are "reference-based" meaning that a paymentReference derived from the request contents is logged on-chain via a smart contract that emits an event. Nothing gets written back to IPFS when paying a "reference-based" request.

  The exception is when paying a "declarative" request, in which case, data *is* written back to IPFS. This includes when the payer declares that the payment was sent and the payee declares that the payment was received.
</Info>

## Retrieve a request / Detect a payment

* The event is indexed by the payments subgraph
* An app can retrieve the request contents from IPFS and calculate the balance based on events from the payments subgraph.

<Info>
  The request balance is calculated by adding up all the on-chain payment events with the same paymentReference. Partial payments are possible.
</Info>

All of these steps are facilitated by the Request Network API. See the [Quickstart](/use-cases/quickstart) for the end-to-end flow.


## Related topics

- [Query Requests](/api-features/query-requests.md)
- [Commerce Payments (Preview)](/api-features/commerce-payments.md)
- [Recurring Payments](/api-features/recurring-payments.md)
