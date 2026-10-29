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

### Building and verifying identity updates locally

`IdentityUpdateRequestDetails` now merges partial edits into the identity decoded from `rawIdentityTransaction`. Construction never calls `updateidentity` or `signdata`, and failures never fall back to those RPCs. Chain-state reads, funding, and broadcast remain separate. Historical content-multimap entries are cleared; explicitly requested ordinary entries and new upload references are retained. Protected currency/control flags, authority checks, and lock/unlock calculations follow the PBaaS rules. Updates require version 3 source and resulting identities with supported state flags; unverified legacy migrations fail before funding, including full-identity and supplied-template calls. Full-identity requests also undergo source-to-result transition checks and must supply a valid final lock state.

Unsigned public and private data uploads require wallet callbacks:

```typescript
import { LocalIdentityUploadCrypto } from 'verusid-ts-client';

const localUploadCrypto: LocalIdentityUploadCrypto = {
  randomBytes: length => wallet.secureRandomBytes(length),
  encrypt: async (plaintext, address) => {
    // Mobile's native API returns these exact field names. The adapter must
    // retain any temporary symmetric key privately for verification below.
    const result = await wallet.encryptVerusData(address, plaintext.toString('hex'));
    return {
      epk: Buffer.from(result.ephemeralPublicKey, 'hex'),
      ciphertext: Buffer.from(result.encryptedData, 'hex'),
    };
  },
  createPublicRecipient: () => wallet.createFreshPublicUploadRecipient(),
  decryptData: (descriptor, context) => wallet.authenticateAndDecryptUpload(descriptor, context),
};
```

The `wallet` methods above are application adapters, not exports of this package. `encrypt` receives complete VDXF-tagged descriptor bytes. It must use a fresh Sapling ephemeral key for every call, the Sapling KDF, and authenticated ChaCha20-Poly1305 with the daemon's parameters. Return buffers without reversing them. `createPublicRecipient` returns `{ address, ivk: Buffer }` from genuinely fresh key material; its IVK is published. Private uploads do not need this callback. Verus and VRSCTEST use `zs` Sapling addresses.

Pass the adapter as the final `localUploadCrypto` argument to `createUpdateIdentityTransaction` (after the existing `decryptData` argument), or as `options.localUploadCrypto` to `createUpdateIdentityWithCurrencyTransferTransaction`. Its `decryptData` is used automatically unless the existing explicit callback is supplied. A supplied `updateIdentityTransactionHex` needs only `decryptData`; it undergoes the same request and commitment checks. Requests must target the configured chain and remain unexpired. Local transaction expiry is capped by the request expiry. The selected expiry must be at least four blocks ahead to satisfy daemon relay policy; supplied templates must expire within 40 blocks and no later than the request expiry. Lock calculations use that exact expiry. Local templates select one height and expiry for the complete update, including any appended transfers. The default height is `getinfo.blocks` (the active chain); an explicit `currentHeight` must also be a trusted active tip. The shared lock rules preserve the daemon's inclusive unlock boundary, signed lock-delay normalization, and wrapping uint32 arithmetic. Full identity inputs describe final binary state, so they are validated without RPC-style normalization.

`verifyIdentityUpdateFunding(approval, candidateHex, signingInputs, lockContext)` and `signUpdateIdentityTransaction(hex, inputs, keys, approval, lockContext)` accept an optional `IdentityLockContext` of `{ chainId, nextBlockHeight }`. Obtain it independently from trusted current chain state before signing. Without it, verification requires the lock transition to be valid at **every** possible nonexpired inclusion height; clearing an elapsed countdown can therefore require this context. A claimed height inside an externally supplied receipt is never used. Neither method fetches or proves current UTXO state. The historical vARRR exception is implemented for heights 67,000–76,999; affected earlier states fail closed because their on-chain upgrade activation is unavailable.

For an external private recipient, the wallet may request a temporary symmetric key from native encryption and retain it in memory keyed by the exact EPK/ciphertext. The decrypt callback must authenticate the ciphertext with that key, not return remembered plaintext. Clear temporary keys after the builder finishes or fails. Never return them to the SDK, publish them, or send them to RPC. Public uploads can decrypt using the IVK supplied on detached callback descriptors, including their children.

The verifier checks all requested plaintext, metadata, salts, ordered leaf hashes, MMR roots, references, evidence coverage, and multipart structure before funding. SHA-256, SHA-256d, and personalized Blake2b object/MMR hashes are supported. Use inline bytes and explicitly enable `createmmr`. Supplied salts must be exactly 32 bytes per item. Hash-only leaves require a multi-item MMR. Data signatures, signature bindings, prior MMRs, remote filenames, and unsupported metadata are rejected.

The primitives dependency and transitive resolution are pinned to `master` commit `f7de920e32e8d4778356c18ce8bb6d3a22ec72a3`, which includes the merged identity-registration changes. `yarn update-verus-libs` follows `master` for primitives. Its MMR CLI parser now rejects bare strings, per-item metadata, prior MMRs, and `serializedbase64`; use `{ message: text }` or `{ serializedhex: hex }`. Single `messagebase64` uploads remain supported. The SDK also accepts already-decoded typed Buffer payloads locally, including MMR RAWSTRING/BASE64, without converting them back into RPC requests. These local inputs do not imply daemon CLI support.

Descriptor and VDXF `fromJson`/`toJson` now use the lossless daemon representation: raw strings are hexadecimal, tagged bytes are numeric, and fields or sequences the daemon would drop or reorder are rejected. Native binary values, including tagged byte vectors and descriptor VDXF keys, remain usable in local uploads. The SDK preserves their bytes without a JSON round-trip and resolves compact FQN keys to ordinary VDXF keys. Use constructors/binary serialization when a value has no lossless JSON form; identity signing-policy checks also work with such content.

Limits are 1,000,000 payload bytes, 4,096 total items, 1,500,000 evidence-output bytes, and 1,800,000 bytes for the final transaction. Identity/script limits also apply. Only one multipart upload group is produced per transaction because the daemon cannot reliably retrieve adjacent multipart groups. Evidence order and absolute output positions must survive funding. The dynamic fee allowance includes the daemon’s default storage charge of 1,000 atomic units per evidence-script byte. Custom chain or node fee policies may require an explicit cap. The allowance remains a ceiling, not a quote; callers can supply a lower `maxFee` and inspect the verified `deltas`/approval before signing.

Standalone verification is available as `verifyIdentityUpdateData(request, hex, decryptData, expectedChainId?)`. It does not replace funding or identity-authorization checks. Retain the returned transaction and funding approval for signing; retain exact signed bytes and their transaction ID for broadcast retries instead of rebuilding and re-encrypting.

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

`sendIdentityRegistrationTransaction(prepared, signedHex, expectedChangeAddress?)` verifies approved intent, independent currency accounting, and complete signatures immediately before each RPC send, including retries. It checks the returned transaction ID against the exact bytes sent and returns the successful RPC response. After submission starts, a transport error, RPC error, missing response, or different returned ID throws `RegistrationError` with code `BROADCAST_UNKNOWN` and the submitted transaction ID in `details.txid`. This means the transaction may have been accepted; check that ID before retrying. Local validation failures occur before any send. The optional change address is an additional approval retained by the application; if supplied, both the plan and actual change must match it. Otherwise the original prepared plan supplies that approval. Never replace the retained approval with a candidate received from another party. Raw `interface.sendRawTransaction` is a generic RPC operation and does not run these registration checks.

The same signing flow applies to `commitment.transaction`. Signing requires the original prepared transaction under `transaction`; the earlier raw `txHex`/`prevouts` signing form is rejected. Supply an optional `txHex` for a partially signed candidate or `partialTransactions` for external signatures. Every candidate is validated against the retained plan before any key is used. `mergeIdentityRegistrationTransactions({ transaction: registration, partialTransactions })` applies the same checks before combining signatures. `inspectIdentityRegistrationSignatures({ txHex, prevouts, identityAuthorities })` reports signature status without approving transaction costs. A restricted namespace may require several signatures on one commitment input. Preserve partial results until all required authorities have signed, then broadcast only the completed transaction after validation.

Persist the reservation and exact signed transactions in the application. After interruption, reconcile the recorded txid/outpoint with chain state and resume the existing operation. Rebuild an expired registration with refreshed costs and funding while its commitment remains unspent. Builders rely on RPC chain-state evidence; offline tests verify construction and validation, and do not establish acceptance by a live daemon.

Construction refreshes authorities and chain state. Local signing, merging, and validation use the prepared snapshot; rebuild and review the transaction if the identity authorities, commitment state, policy, or expiry change while collecting signatures. Run `npm run build` and `npm run test:offline` for the build and offline regression checks.

### Updating or transferring an identity safely

`createUpdateIdentityTransaction` and `createUpdateIdentityWithCurrencyTransferTransaction` verify selected funding prevouts against their actual raw transactions, then independently account for native and every reserve currency. The verified result includes an immutable `fundingApproval`, with the intended outputs, exact fees, permitted change destination, and raw source transactions. Retain this original approval separately from transaction bytes received from another party.

```typescript
import { verifyIdentityUpdateFunding } from 'verusid-ts-client';

const prepared = await verusIdClient.createUpdateIdentityTransaction(
  approvedIdentity, changeAddress, rawIdentityTransaction,
  identityTransactionHeight, approvedFundingUtxos, chainId,
);
const approval = prepared.fundingApproval;
if (!approval) throw new Error('A verified funding approval is required.');

verifyIdentityUpdateFunding(approval, prepared.hex, prepared.utxos);
const signedHex = verusIdClient.signUpdateIdentityTransaction(
  prepared.hex, prepared.utxos, approvedKeysByInput, approval,
);
// Persist the exact signed bytes before attempting delivery.
verifyIdentityUpdateFunding(approval, signedHex, prepared.utxos);
// Broadcast signedHex only after completing signature and current-state checks.
```

The signer's optional fourth argument verifies the retained approval before and after signing. Call `verifyIdentityUpdateFunding` immediately before every broadcast, including a retry. It permits input signature scripts to change while requiring the approved transaction body, all raw prevouts, source scripts and values, change, and currency totals to match. It does not verify signature completeness, current ownership, confirmation state, unspent state, or expiry; applications must check those independently. Generic `interface.sendRawTransaction` does not run this verifier.

`maxFee` remains a coin-denominated number, but must be finite, nonnegative, and an exact atomic amount. When omitted, the default is a bounded allowance with a 0.001-coin floor, scaled for the planned identity's content and address fee factors, outputs including potential change, and large scripts. Explicit native transfer fees are additional allowance. The returned `nativeFee`, `fees`, and `maxFee` use atomic-unit strings; review actual costs rather than treating the cap as a quote. Unusual daemon storage-fee settings may require an explicitly approved higher cap.

Ordinary canonical P2PKH, P2PK funding, and supported version-3 native/reserve outputs are accounted from their scripts. Unknown or ambiguous scripts, duplicate outpoints or currency-map keys, hidden reserve losses, altered change destinations, and value-bearing identity definition inputs are rejected. An identity definition with a native deposit requires a separate explicitly reviewed workflow. Combined transfers retain each intended payment separately from change; multi-primary identity policies can be approved with both `expectedIdentityPrimaryAddresses` and `expectedIdentityMinimumSignatures`.

The explicit `allowUnverifiedPrevouts` escape hatch is restricted to `NODE_ENV=test` for trusted static fixtures. Enabling it in any other environment throws before RPC work; direct trusted-prevout fallback calls are also guarded. It still performs structural/accounting checks but does not establish raw-prevout authenticity and returns no portable `fundingApproval`. Omitting funding inputs produces an unfunded template, also without an approval. Neither result is suitable for this verified signing/broadcast workflow.

## Contributing

Contributions to `verusid-ts-client` are welcome! Please refer to the project's issues page for proposed features and bug reports. Follow the contribution guidelines for pull requests.
