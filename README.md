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

## Usage

### Initializing the VerusID Interface

```typescript
import VerusIdInterface from 'verusid-ts-client';
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

## Contributing

Contributions to `verusid-ts-client` are welcome! Please refer to the project's issues page for proposed features and bug reports. Follow the contribution guidelines for pull requests.
