# verusid-ts-client

## Overview

The `verusid-ts-client` library is a TypeScript client designed to utilize VerusID functionality in a lite client, providing functionalities for creating and verifying digital signatures, handling login consents, managing VerusPay invoices, and more, using VerusID's blockchain technology.

## Installation

To add `verusid-ts-client` to your project, use the following command with yarn:

```bash
yarn add https://github.com/VerusCoin/verusid-ts-client.git
```

## Features

- **VerusID Interface**: Main class providing methods to interact with VerusID.
- **Blockchain Interaction**: Functions to get current blockchain height and chain ID.
- **Message and Hash Signing**: Methods to sign messages and hashes with VerusID signatures.
- **Login Consent Handling**: Tools to create, sign, and verify VerusID login consent requests and responses.
- **VerusPay Invoice Management**: Functions to create, sign, and verify VerusPay v3 invoices.
- **Identity Registration**: Resolve namespace policy and costs, build commitment and registration transactions, and sign or merge their authorization locally.

## Usage

### Initializing the VerusID Interface

```typescript
import { VerusIdInterface } from 'verusid-ts-client';
import { AxiosRequestConfig } from 'axios';

const config: AxiosRequestConfig = {/* Axios configuration */};
const verusIdClient = new VerusIdInterface('root-system-currency-id', 'http://your-verusd-node.com', config);
```

### Signing a Message

```typescript
async function signAMessage() {
  const message = "Hello, Verus!";
  const iAddrOrIdentity = "VerusID@";
  const primaryAddrWif = "yourWIFhere";

  try {
    const signature = await verusIdClient.signMessage(iAddrOrIdentity, message, primaryAddrWif);
    console.log(signature);
  } catch (error) {
    console.error(error);
  }
}
```

### Verifying a Message Signature

```typescript
async function verifyAMessageSignature() {
  const base64Sig = "signatureInBase64";
  const message = "Hello, Verus!";
  const iAddrOrIdentity = "VerusID@";

  try {
    const isValid = await verusIdClient.verifyMessage(iAddrOrIdentity, base64Sig, message);
    console.log(isValid ? "Valid signature" : "Invalid signature");
  } catch (error) {
    console.error(error);
  }
}
```

### Handling Login Consent

Creating and signing a login consent request:

```typescript
import { LoginConsentChallenge } from 'verus-typescript-primitives';

async function createAndSignLoginConsent() {
  const challenge = new LoginConsentChallenge(/* Challenge details */);
  const signingId = "VerusID@";
  const primaryAddrWif = "yourWIFhere";

  try {
    const request = await verusIdClient.createLoginConsentRequest(signingId, challenge, primaryAddrWif);
    console.log(request);
  } catch (error) {
    console.error(error);
  }
}
```

Verifying a login consent request:

```typescript
async function verifyLoginConsent() {
  const request = /* previously created request */;

  try {
    const isValid = await verusIdClient.verifyLoginConsentRequest(request);
    console.log(isValid ? "Valid request" : "Invalid request");
  } catch (error) {
    console.error(error);
  }
}
```

### Creating VerusPay Invoices

```typescript
import { VerusPayInvoiceDetails } from 'verus-typescript-primitives';

async function createVerusPayInvoice() {
  const details = new VerusPayInvoiceDetails(/* Invoice details */);
  const signingIdIAddr = "VerusID@";
  const primaryAddrWif = "yourWIFhere";

  try {
    const invoice = await verusIdClient.createVerusPayInvoice(details, signingIdIAddr, primaryAddrWif);
    console.log(invoice);
  } catch (error) {
    console.error(error);
  }
}
```

### Registering an identity

Identity registration has two transactions. `createNameReservationTransaction` creates the **commitment transaction** and a private reservation record. After that commitment confirms, `createIdentityRegistrationTransaction` spends its exact outpoint to publish the reservation and create the identity. These methods do not broadcast or wait for confirmations.

The client supports modern advanced reservations for the native chain and supported non-fractional token namespaces, including referrals and issuer/referrer authorization. A parent must be an eligible registered currency namespace; owning an ordinary VerusID does not make it an issuance namespace. Fractional/gateway pricing, legacy reservation creation, unsupported payment policies, and shielded funding are rejected before constructing a commitment.

Use explicit network context. `rootSystemName` is the global root name, such as `VRSC` or `VRSCTEST`; `systemID` identifies the chain that will register the identity. A leaf with a non-root `parent` also needs `parentName`. Fully qualified names and explicit parent selections must agree.

```typescript
const request = {
  name: 'alice',
  rootSystemName: 'VRSCTEST',
  systemID: registrationSystemID,
  // parent: namespaceID,
  // parentName: 'community',
  // referralID: referringIdentityID,
};

const { policy, quote, snapshot } =
  await verusIdClient.resolveIdentityRegistration(request);
```

Review the quote and supply `approvedCosts`, a map from currency i-address to the maximum approved cost as a decimal string of **atomic units**. For commitment creation this bounds the full operation (`quote.totalOperationRequired`); for the reveal it bounds that transaction (`quote.totalRequired`). The quote also separates `commitmentFee`, `nativeFee`, referral payments, issuer payment/burn, and transfer fees. Optional `commitmentFee` and `offer` arguments use atomic strings; `expiryDelta` controls the transaction lifetime in blocks within the supported bounds.

Funding inputs identify approved outpoints with `{ txid, vout, rawTransaction? }`. Values and scripts are verified from their source transactions and checked against current unspent-output RPC data; caller-supplied balances are not trusted. The commitment builder checks that approved funding covers both stages, then selects enough inputs for its own fee. Supply current unspent outpoints, including any commitment-transaction change, when funding the reveal. Funding/change preserve native and reserve-currency balances. An i-address used for change must be an existing usable identity, verified against its defining transaction; the reveal may also return change to the identity it creates. Commitment change cannot go to that future identity. Native values are limited to 2,100,000,000,000,000 atomic units per input/output by the pinned transaction library. Reserve values use exact integer arithmetic, with individual and per-currency aggregate amounts limited to the daemon's 5,000,000,000,000,000,000 atomic units.

Ordinary funding supports P2PKH and simple version-3 smart native/reserve outputs addressed to public-key hashes or identities. Special-purpose outputs (including reserve transfers/deposits, identity definitions, token-bearing commitments, and notarization/import/export state), coinbase outputs, and other script families are rejected. Only the exact approved ordinary name commitment can be consumed as a special reveal input. Selection also enforces the daemon's script envelope and parameter-size limits: if combining reserves would make the single change output too large, it fails before returning a transaction. Supply a smaller funding set in that case; selection does not automatically split change or search alternative input subsets.

```typescript
const commitment = await verusIdClient.createNameReservationTransaction({
  ...request,
  controller: commitmentControllerAddress,
  salt: secureRandomBytes(32), // Use your platform's cryptographic RNG.
  funding: approvedCommitmentFunding,
  changeAddress: fundingChangeAddress,
  approvedCosts,
});

// Persist commitment.reservation in encrypted storage before signing/sending.
// Sign commitment.transaction, persist its final signed bytes and txid,
// and broadcast with sendIdentityRegistrationTransaction.
```

The returned `reservation` is a serializable, immutable version-1 record containing the advanced reservation bytes, name/network context, and commitment-controller/authorization information. Its `reservationHex` includes the secret salt. Keep the complete record out of logs and ordinary RPC calls until reveal; the salt cannot be recovered from a wallet seed. The `salt` argument is a 32-byte buffer in the primitive's internal byte order. Persist the returned bytes instead of reconstructing the record from displayed JSON fields.

Use the **signed** commitment transaction's txid and the returned `commitmentVout` for the second transaction. A commitment does not reserve exclusive ownership of the name. The registration builder rechecks availability, policy, fees, and the confirmed, unspent commitment. An unconfirmed or reorganized commitment cannot be used to reveal.

```typescript
const registration = await verusIdClient.createIdentityRegistrationTransaction({
  reservation: commitment.reservation,
  commitment: {
    txid: signedCommitmentTxid,
    vout: commitment.commitmentVout,
    rawTransaction: signedCommitmentHex, // Optional; fetched if omitted.
  },
  identity: approvedIdentity, // Identity or full VerusCLIVerusIDJson.
  funding: approvedRegistrationFunding,
  changeAddress: fundingChangeAddress,
  approvedCosts: approvedRegistrationCosts,
});
```

The identity must preserve the reserved leaf name byte for byte and use the reserved parent and registration system. Supply its full approved definition, including primary addresses, signature threshold, and recovery/revocation authorities. Primary addresses currently support transparent public-key hashes. The reservation does not freeze the other identity fields; approve the complete identity again when preparing the registration.

Prepared transactions include `txHex` (also exposed as `hex`), verified `prevouts` in input order, `requiredSignatures`, `identityAuthorities`, `revealAuthorities`, `outputPlan`, `quote`, `snapshot`, `changeAddress`, and `approvedCosts`. Reveal plans also retain the approved `commitment` outpoint. Requests are copied before RPC work begins, and returned prepared transactions are deeply frozen. Retain the original approved transaction independently of anything received from a co-signer. `validateIdentityRegistrationTransaction(prepared, candidateHex?)` checks transaction intent, actual costs against the quote and approvals, the change recipient, and any supplied signatures, returning `{ valid: true, signingStatus, inputs, ... }`. A valid unsigned or partial transaction still requires the missing signatures before broadcast.

Coin selection independently verifies the transaction before returning it. This second accounting implementation reads amounts from actual source transactions and output scripts, rather than trusting the selector's balance metadata. It requires the exact approved native fee, preserves every reserve currency including unrelated assets carried by funding inputs, checks the approved change destination, and rejects unsupported or ambiguous output types. Callers remain responsible for controlling that destination. Registration construction, signing, merging, and validation also run the independent check against the quote. `verifyIdentityRegistrationFunding(prepared, candidateHex?, expectedChangeAddress?)` exposes that check directly without RPC calls or signature verification; it throws `REGISTRATION_FUNDING_MISMATCH` on failure. The standalone `verifyRegistrationFunding(funded, approval, candidateHex?)` supports lower-level callers with explicit approved outputs, fee, change address, chain snapshot, and optional mandatory commitment outpoint.

```typescript
verusIdClient.validateIdentityRegistrationTransaction(registration);
const signed = verusIdClient.signIdentityRegistrationTransaction({
  transaction: registration,
  keys: approvedWifKeysByInput, // string[][] in exact prevout order.
});
verusIdClient.validateIdentityRegistrationTransaction(registration, signed.txHex);

if (signed.signingStatus === 'complete') {
  // Persist signed.txHex and signed.txid BEFORE sending.
  const response = await verusIdClient.sendIdentityRegistrationTransaction(
    registration,
    signed.txHex,
    fundingChangeAddress,
  );
  if (response.error) throw new Error(response.error.message);
} else {
  // Persist the partial result and obtain the missing signatures in signed.inputs.
}
```

`sendIdentityRegistrationTransaction(prepared, signedHex, expectedChangeAddress?)` verifies approved intent, independent currency accounting, and complete signatures immediately before each RPC send, including retries. It checks the returned transaction ID and returns the RPC response. The optional change address is an additional approval retained by the application; if supplied, both the plan and actual change must match it. Otherwise the original prepared plan supplies that approval. Never replace the retained approval with a candidate received from another party. Raw `interface.sendRawTransaction` is a generic RPC operation and does not run these registration checks.

The same signing flow applies to `commitment.transaction`. Signing requires the original prepared transaction under `transaction`; the earlier raw `txHex`/`prevouts` signing form is rejected. Supply an optional `txHex` for a partially signed candidate or `partialTransactions` for external signatures. Every candidate is validated against the retained plan before any key is used. `mergeIdentityRegistrationTransactions({ transaction: registration, partialTransactions })` applies the same checks before combining signatures. `inspectIdentityRegistrationSignatures({ txHex, prevouts, identityAuthorities })` reports signature status without approving transaction costs. A restricted namespace may require several signatures on one commitment input. Preserve partial results until all required authorities have signed, then broadcast only the completed transaction after validation.

Persist the reservation and exact signed transactions in the application. After interruption, reconcile the recorded txid/outpoint with chain state and resume the existing operation. Rebuild an expired registration with refreshed costs and funding while its commitment remains unspent. Builders rely on RPC chain-state evidence; offline tests verify construction and validation, and do not establish acceptance by a live daemon.

Construction refreshes authorities and chain state. Local signing, merging, and validation use the prepared snapshot; rebuild and review the transaction if the identity authorities, commitment state, policy, or expiry change while collecting signatures. Run `npm run build` and `npm run test:offline` for the build and offline regression checks.

## Contributing

Contributions to `verusid-ts-client` are welcome! Please refer to the project's issues page for proposed features and bug reports. Follow the contribution guidelines for pull requests.
