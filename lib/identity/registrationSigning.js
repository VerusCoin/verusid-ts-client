"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateRegistrationIdentityAuthorities = validateRegistrationIdentityAuthorities;
exports.signIdentityRegistrationTransaction = signIdentityRegistrationTransaction;
exports.inspectIdentityRegistrationSignatures = inspectIdentityRegistrationSignatures;
exports.mergeIdentityRegistrationTransactions = mergeIdentityRegistrationTransactions;
const bn_js_1 = __importDefault(require("bn.js"));
const verus_typescript_primitives_1 = require("verus-typescript-primitives");
const utxo_lib_1 = require("@bitgo/utxo-lib");
const SECP256K1_ORDER = new bn_js_1.default("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", 16);
function requireHex(value, label) {
    if (typeof value !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(value)) {
        throw new Error(`${label} must be nonempty hex`);
    }
    return Buffer.from(value, "hex");
}
function readTransaction(hex, network) {
    const bytes = requireHex(hex, "Transaction");
    // The dependency rejects shielded spends, shielded outputs, joinsplits, and
    // nonzero valueBalance. Its strict parser also rejects trailing bytes.
    const transaction = utxo_lib_1.Transaction.fromBuffer(bytes, network);
    if (!transaction.toBuffer().equals(bytes)) {
        throw new Error("Noncanonical transaction serialization");
    }
    return transaction;
}
function skeleton(transaction) {
    const copy = transaction.clone();
    copy.ins.forEach((input) => {
        input.script = Buffer.alloc(0);
    });
    return copy.toHex();
}
function keyID(publicKey, network) {
    utxo_lib_1.ECPair.fromPublicKeyBuffer(publicKey, network);
    return utxo_lib_1.address.toBase58Check(utxo_lib_1.crypto.hash160(publicKey), network.pubKeyHash);
}
function authorityMap(authorities, network) {
    const result = new Map();
    for (const authority of authorities) {
        const identity = utxo_lib_1.address.fromBase58Check(authority.identityID);
        if (identity.version !== network.verusID ||
            identity.hash.length !== 20 ||
            identity.hash.equals(Buffer.alloc(20)) ||
            result.has(authority.identityID)) {
            throw new Error("Invalid or duplicate identity authorization context");
        }
        if (authority.revoked)
            throw new Error("A revoked identity cannot authorize registration");
        if (!Array.isArray(authority.primaryAddresses) ||
            authority.primaryAddresses.length < 1 ||
            authority.primaryAddresses.length > 25 ||
            !Number.isInteger(authority.minimumSignatures) ||
            authority.minimumSignatures < 1 ||
            authority.minimumSignatures > 13 ||
            authority.minimumSignatures > authority.primaryAddresses.length) {
            throw new Error("Invalid identity authorization threshold");
        }
        const eligibleKeyIDs = authority.primaryAddresses.map((primary) => {
            if (/^(02|03)[0-9a-fA-F]{64}$/.test(primary)) {
                return keyID(Buffer.from(primary, "hex"), network);
            }
            const decoded = utxo_lib_1.address.fromBase58Check(primary);
            if (decoded.version !== network.pubKeyHash ||
                decoded.hash.length !== 20 ||
                decoded.hash.equals(Buffer.alloc(20))) {
                throw new Error("Identity primary authorities must be public keys or key hashes");
            }
            return primary;
        });
        if (new Set(eligibleKeyIDs).size !== eligibleKeyIDs.length) {
            throw new Error("Duplicate identity primary key");
        }
        result.set(authority.identityID, {
            destination: authority.identityID,
            identityID: authority.identityID,
            threshold: authority.minimumSignatures,
            eligibleKeyIDs,
        });
    }
    return result;
}
/** Validate identity key membership and thresholds before paying a commitment fee. */
function validateRegistrationIdentityAuthorities(authorities) {
    authorityMap(authorities, utxo_lib_1.networks.verus);
}
function destinationCondition(destination, authorities, network) {
    if (destination.type.eq(verus_typescript_primitives_1.TxDestination.TYPE_PK)) {
        const publicKey = destination.data.toBuffer();
        if (publicKey.length !== 33)
            throw new Error("Smart inputs require compressed public keys");
        return {
            destination: publicKey.toString("hex"),
            threshold: 1,
            eligibleKeyIDs: [keyID(publicKey, network)],
        };
    }
    if (destination.type.eq(verus_typescript_primitives_1.TxDestination.TYPE_PKH)) {
        const decoded = utxo_lib_1.address.fromBase58Check(destination.toAddress());
        if (decoded.version !== network.pubKeyHash ||
            decoded.hash.equals(Buffer.alloc(20))) {
            throw new Error("Invalid input key destination");
        }
        return {
            destination: destination.toAddress(),
            threshold: 1,
            eligibleKeyIDs: [destination.toAddress()],
        };
    }
    if (destination.type.eq(verus_typescript_primitives_1.TxDestination.TYPE_ID)) {
        const identityID = destination.toAddress();
        const decoded = utxo_lib_1.address.fromBase58Check(identityID);
        if (decoded.version !== network.verusID ||
            decoded.hash.equals(Buffer.alloc(20))) {
            throw new Error("Invalid input identity destination");
        }
        return (authorities.get(identityID) || {
            destination: identityID,
            identityID,
            threshold: null,
            eligibleKeyIDs: [],
        });
    }
    throw new Error("Unsupported registration input destination");
}
function parseInput(output, authorities, network) {
    if (!Number.isSafeInteger(output.value) || output.value < 0) {
        throw new Error("Input value is not a safe nonnegative atomic amount");
    }
    if (output.value > 2100000000000000) {
        throw new Error("Native input value exceeds the transaction library monetary limit");
    }
    if (utxo_lib_1.script.pubKeyHash.output.check(output.script)) {
        const destination = new verus_typescript_primitives_1.TxDestination(new verus_typescript_primitives_1.KeyID(utxo_lib_1.script.pubKeyHash.output.decode(output.script)));
        return Object.assign(Object.assign({}, output), { smart: false, threshold: 1, conditions: [destinationCondition(destination, authorities, network)] });
    }
    const smart = new verus_typescript_primitives_1.SmartTransactionScript();
    if (smart.fromBuffer(output.script) !== output.script.length ||
        !smart.toBuffer().equals(output.script)) {
        throw new Error("Noncanonical smart input script");
    }
    const master = smart.masterOptCC;
    const params = smart.paramsOptCC;
    for (const part of [master, params]) {
        if (!part.version.eqn(3) ||
            !part.n.eqn(part.destinations.length) ||
            part.m.gt(part.n)) {
            throw new Error("Invalid smart input parameters");
        }
    }
    if (!master.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_NONE) ||
        master.vData.length !== 0 ||
        params.m.ltn(1)) {
        throw new Error("Unsupported smart input condition");
    }
    if (params.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_IDENTITY_COMMITMENT)) {
        const commitment = new verus_typescript_primitives_1.IdentityCommitmentScript();
        commitment.fromBuffer(output.script);
        const hash = commitment.getCommitment();
        if (hash.isAdvanced())
            throw new Error("Advanced offer commitments cannot fund registration");
    }
    else if (params.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_NONE) ||
        params.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_RESERVE_OUTPUT)) {
        if (!(master.m.eqn(0) && master.n.eqn(0)) &&
            !(master.m.eq(params.m) &&
                master.n.eq(params.n) &&
                master.destinations.every((destination, index) => destination.toBuffer().equals(params.destinations[index].toBuffer())))) {
            throw new Error("Unsupported smart funding master condition");
        }
        if (params.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_NONE)) {
            if (params.vData.length !== 0)
                throw new Error("Unexpected smart funding payload");
        }
        else {
            const token = new verus_typescript_primitives_1.TokenOutput();
            if (params.vData.length !== 1 ||
                token.fromBuffer(params.vData[0]) !== params.vData[0].length ||
                !token.isValid() ||
                !token.toBuffer().equals(params.vData[0])) {
                throw new Error("Invalid reserve funding payload");
            }
        }
    }
    else {
        throw new Error("Unsupported registration input eval; identity definitions and reservations cannot be funding inputs");
    }
    return Object.assign(Object.assign({}, output), { smart: true, threshold: params.m.toNumber(), conditions: params.destinations.map((destination) => destinationCondition(destination, authorities, network)) });
}
function verifySignatures(transaction, index, input, network) {
    const result = new Map();
    const bytes = transaction.ins[index].script;
    if (bytes.length === 0)
        return result;
    const chunks = utxo_lib_1.script.decompile(bytes);
    if (!chunks || !utxo_lib_1.script.compile(chunks).equals(bytes))
        throw new Error("Noncanonical input fulfillment");
    const digest = transaction.hashForSignatureByNetwork(index, input.script, input.value, utxo_lib_1.Transaction.SIGHASH_ALL, false);
    const add = (publicKey, signature) => {
        if (input.smart && publicKey.length !== 33)
            throw new Error("Smart inputs require compressed public keys");
        const id = keyID(publicKey, network);
        if (result.has(id))
            throw new Error("Duplicate input signature");
        // BitGo's verifier normalizes high-S signatures before checking them. The
        // daemon's compact-signature verifier does not, so reject them explicitly.
        const r = new bn_js_1.default(signature.r.toBuffer(32));
        const s = new bn_js_1.default(signature.s.toBuffer(32));
        if (r.isZero() ||
            r.gte(SECP256K1_ORDER) ||
            s.isZero() ||
            s.gt(SECP256K1_ORDER.shrn(1))) {
            throw new Error("Registration input signature must have canonical low-S scalars");
        }
        if (!utxo_lib_1.ECPair.fromPublicKeyBuffer(publicKey, network).verify(digest, signature)) {
            throw new Error("Invalid registration input signature");
        }
        if (!input.conditions.some((condition) => condition.threshold === null ||
            condition.eligibleKeyIDs.indexOf(id) !== -1)) {
            throw new Error("Signature does not authorize this input");
        }
        result.set(id, { publicKey, signature });
    };
    if (input.smart) {
        if (chunks.length !== 1 || !Buffer.isBuffer(chunks[0]))
            throw new Error("Invalid smart fulfillment");
        const collection = new utxo_lib_1.SmartTransactionSignatures();
        const consumed = collection.fromBuffer(chunks[0]);
        if (collection.error ||
            consumed !== chunks[0].length ||
            collection.version !== 1 ||
            collection.sigHashType !== utxo_lib_1.Transaction.SIGHASH_ALL ||
            !collection.isValid() ||
            !collection.toBuffer().equals(chunks[0])) {
            throw new Error("Smart signatures must be canonical and use SIGHASH_ALL");
        }
        collection.signatures.forEach((entry) => {
            if (entry.sigType !== 1 || entry.oneSignature.length !== 64)
                throw new Error("Unsupported smart signature type");
            add(entry.pubKeyData, utxo_lib_1.ECSignature.fromRSBuffer(entry.oneSignature));
        });
    }
    else {
        if (chunks.length !== 2 ||
            !Buffer.isBuffer(chunks[0]) ||
            !Buffer.isBuffer(chunks[1])) {
            throw new Error("Invalid P2PKH fulfillment");
        }
        const parsed = utxo_lib_1.ECSignature.parseScriptSignature(chunks[0]);
        if (parsed.hashType !== utxo_lib_1.Transaction.SIGHASH_ALL)
            throw new Error("Registration signatures must use SIGHASH_ALL");
        add(chunks[1], parsed.signature);
    }
    return result;
}
/**
 * Verify/merge only signatures against an approved transaction and raw prevouts.
 * Economic and registration-policy validation belongs to the prepared builder;
 * this function never approves a change to that transaction's contents.
 */
function signIdentityRegistrationTransaction(args) {
    const network = args.network || utxo_lib_1.networks.verus;
    if (network.coin !== utxo_lib_1.networks.verus.coin ||
        network.pubKeyHash !== utxo_lib_1.networks.verus.pubKeyHash ||
        network.verusID !== utxo_lib_1.networks.verus.verusID ||
        network.wif !== utxo_lib_1.networks.verus.wif ||
        !network.consensusBranchId ||
        network.consensusBranchId[4] !== utxo_lib_1.networks.verus.consensusBranchId[4]) {
        throw new Error("Unsupported registration signing network or consensus branch");
    }
    const transaction = readTransaction(args.txHex, network);
    if (transaction.version !== 4 ||
        transaction.overwintered !== 1 ||
        transaction.versionGroupId !== 0x892f2085 ||
        transaction.ins.length === 0 ||
        transaction.outs.length === 0) {
        throw new Error("Registration signing requires a funded transparent Sapling transaction");
    }
    if (args.prevouts.length !== transaction.ins.length ||
        (args.keys && args.keys.length !== transaction.ins.length)) {
        throw new Error("Prevouts and key arrays must match transaction input order");
    }
    const authorities = authorityMap(args.identityAuthorities || [], network);
    const seen = new Set();
    const inputs = args.prevouts.map((prevout, index) => {
        if (!/^[0-9a-fA-F]{64}$/.test(prevout.txid) ||
            !Number.isInteger(prevout.vout) ||
            prevout.vout < 0) {
            throw new Error("Invalid registration prevout");
        }
        const source = readTransaction(prevout.rawTransaction, network);
        const txid = Buffer.from(transaction.ins[index].hash)
            .reverse()
            .toString("hex");
        const outpoint = `${txid}:${prevout.vout}`;
        if (txid !== prevout.txid.toLowerCase() ||
            source.getId() !== txid ||
            transaction.ins[index].index !== prevout.vout ||
            prevout.vout >= source.outs.length ||
            seen.has(outpoint)) {
            throw new Error("Registration prevout does not match input, or is duplicated");
        }
        seen.add(outpoint);
        const output = source.outs[prevout.vout];
        if ((prevout.scriptHex !== undefined &&
            !requireHex(prevout.scriptHex, "Prevout script").equals(output.script)) ||
            (prevout.value !== undefined &&
                (!/^(0|[1-9][0-9]*)$/.test(prevout.value) ||
                    prevout.value !== String(output.value)))) {
            throw new Error("Registration prevout script or value does not match raw transaction");
        }
        return parseInput(output, authorities, network);
    });
    const inputValue = inputs.reduce((sum, input) => sum.add(new bn_js_1.default(input.value)), new bn_js_1.default(0));
    const outputValue = transaction.outs.reduce((sum, output) => {
        if (!Number.isSafeInteger(output.value) ||
            output.value < 0 ||
            output.value > 2100000000000000) {
            throw new Error("Native output value exceeds the transaction library monetary limit");
        }
        return sum.add(new bn_js_1.default(output.value));
    }, new bn_js_1.default(0));
    if (inputValue.lt(outputValue))
        throw new Error("Registration transaction spends more native value than its inputs");
    const signatureMaps = inputs.map((input, index) => verifySignatures(transaction, index, input, network));
    const approved = skeleton(transaction);
    for (const hex of args.partialTransactions || []) {
        const partial = readTransaction(hex, network);
        if (skeleton(partial) !== approved)
            throw new Error("Partial transaction changes the approved transaction");
        inputs.forEach((input, index) => {
            verifySignatures(partial, index, input, network).forEach((signature, id) => {
                if (!signatureMaps[index].has(id))
                    signatureMaps[index].set(id, signature);
            });
        });
    }
    inputs.forEach((input, index) => {
        for (const wif of (args.keys && args.keys[index]) || []) {
            const key = utxo_lib_1.ECPair.fromWIF(wif, network);
            const publicKey = key.getPublicKeyBuffer();
            const id = keyID(publicKey, network);
            if (!input.conditions.some((condition) => condition.eligibleKeyIDs.indexOf(id) !== -1)) {
                throw new Error("Cannot prove this key authorizes the registration input; provide its identity authority context");
            }
            if (input.smart && publicKey.length !== 33)
                throw new Error("Smart inputs require compressed public keys");
            if (!signatureMaps[index].has(id)) {
                const digest = transaction.hashForSignatureByNetwork(index, input.script, input.value, utxo_lib_1.Transaction.SIGHASH_ALL, false);
                signatureMaps[index].set(id, {
                    publicKey,
                    signature: key.sign(digest),
                });
            }
        }
        // CSmartTransactionSignatures serializes its map in raw uint160 key-ID order.
        const signatures = Array.from(signatureMaps[index].values()).sort((a, b) => Buffer.compare(utxo_lib_1.crypto.hash160(a.publicKey), utxo_lib_1.crypto.hash160(b.publicKey)));
        if (signatures.length === 0)
            transaction.ins[index].script = Buffer.alloc(0);
        else if (input.smart) {
            transaction.ins[index].script = utxo_lib_1.script.compile([
                new utxo_lib_1.SmartTransactionSignatures(1, utxo_lib_1.Transaction.SIGHASH_ALL,
                // The pinned ECSignature requires an explicit offset: an omitted offset
                // makes its second integer overwrite the first instead of following it.
                signatures.map((entry) => new utxo_lib_1.SmartTransactionSignature(1, 1, entry.publicKey, entry.signature.toRSBuffer(undefined, 0)))).toBuffer(),
            ]);
        }
        else {
            transaction.ins[index].script = utxo_lib_1.script.pubKeyHash.input.encode(signatures[0].signature.toScriptSignature(utxo_lib_1.Transaction.SIGHASH_ALL), signatures[0].publicKey);
        }
    });
    const statuses = inputs.map((input, index) => {
        const signatures = verifySignatures(transaction, index, input, network);
        const requirements = input.conditions.map((condition) => {
            const signedKeyIDs = condition.eligibleKeyIDs.filter((id) => signatures.has(id));
            return Object.assign(Object.assign({}, condition), { signedKeyIDs, missingSignatures: condition.threshold === null
                    ? null
                    : Math.max(0, condition.threshold - signedKeyIDs.length), unresolvedIdentity: condition.threshold === null });
        });
        return {
            inputIndex: index,
            txid: args.prevouts[index].txid,
            vout: args.prevouts[index].vout,
            threshold: input.threshold,
            complete: requirements.every((requirement) => !requirement.unresolvedIdentity) &&
                requirements.filter((requirement) => requirement.missingSignatures === 0).length >= input.threshold,
            requirements,
        };
    });
    const hex = transaction.toHex();
    return {
        hex,
        txHex: hex,
        txid: transaction.getId(),
        signingStatus: statuses.every((status) => status.complete)
            ? "complete"
            : signatureMaps.some((signatures) => signatures.size > 0)
                ? "partial"
                : "unsigned",
        inputs: statuses,
    };
}
function inspectIdentityRegistrationSignatures(args) {
    return signIdentityRegistrationTransaction(args);
}
function mergeIdentityRegistrationTransactions(args) {
    return signIdentityRegistrationTransaction(args);
}
