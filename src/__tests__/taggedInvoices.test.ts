import { networks, smarttxs, Transaction } from "@bitgo/utxo-lib";
import {
  BigNumber, CompactXAddressObject, DEST_ID, DEST_PKH, EVALS,
  fromBase58Check, ReserveTransfer, SmartTransactionScript, toBase58Check,
  TransferDestination, VerusPayInvoice, VerusPayInvoiceDetails,
} from "verus-typescript-primitives";
import { VerusIdInterface } from "../index";
import { CurrencyTransferOutput } from "../VerusIdInterface";
import { TEST_ID_2, TEST_ID_3, VERUSTEST_I_ADDR } from "./fixtures/verusid";

const bs58check = require("bs58check");

describe("tagged VerusPay invoice payments", () => {
  const system = VERUSTEST_I_ADDR;
  const token = TEST_ID_2.identity.identityaddress;
  const remote = TEST_ID_3.identity.identityaddress;
  const expiry = 31697;
  const tagHash = Buffer.from("000102030405060708090a0b0c0d0e0f10111213", "hex");
  const tag = toBase58Check(tagHash, 137);
  const otherTag = toBase58Check(Buffer.alloc(20, 7), 137);
  const recipient = new TransferDestination({
    type: DEST_PKH,
    destinationBytes: fromBase58Check(TEST_ID_3.identity.primaryaddresses[0]).hash,
  });
  const identity = new TransferDestination({ type: DEST_ID, destinationBytes: fromBase58Check(token).hash });
  const payment: CurrencyTransferOutput = { currencies: { [system]: "100000" }, address: recipient };
  const conversion: CurrencyTransferOutput = { ...payment, convertto: token, feesatoshis: "20000" };
  const parse = (hex: string) => Transaction.fromHex(hex, networks.verus);
  const build = (outputs: CurrencyTransferOutput[]) => parse(
    VerusIdInterface.createUnfundedCurrencyTransferTransaction(system, outputs, expiry)
  );
  const scriptOf = (tx: ReturnType<typeof Transaction.fromHex>, index = 0) => {
    const script = new SmartTransactionScript();
    script.fromBuffer(tx.outs[index].script);
    return script;
  };
  const unpack = (tx: ReturnType<typeof Transaction.fromHex>) => smarttxs.unpackOutput(tx.outs[0], system, false, true);
  const cases: Array<[string, CurrencyTransferOutput, number]> = [
    ["native PKH", payment, EVALS.EVAL_NONE],
    ["native identity", { ...payment, address: identity }, EVALS.EVAL_NONE],
    ["token", { ...payment, currencies: { [token]: "250000" } }, EVALS.EVAL_RESERVE_OUTPUT],
    ["conversion", conversion, EVALS.EVAL_RESERVE_TRANSFER],
    ["preconversion", { ...conversion, preconvert: true }, EVALS.EVAL_RESERVE_TRANSFER],
    ["export", { ...payment, exportto: remote, feesatoshis: "20000" }, EVALS.EVAL_RESERVE_TRANSFER],
  ];

  test.each(cases)("matches BitGoJS for a tagged %s payment and preserves the payment", (name, output, evalCode) => {
    const tagged = build([{ ...output, vdxftag: tag }]);
    const untagged = build([output]);
    const script = scriptOf(tagged);
    // Independent wire expectation: v3, EVAL_NONE, 1-of-1, TYPE_INDEX + 20-byte tag.
    expect(script.masterOptCC.toChunk().toString("hex")).toBe("04030001011505" + tagHash.toString("hex"));
    expect(script.paramsOptCC.evalCode.toNumber()).toBe(evalCode);
    expect(tagged.outs[0].value).toBe(untagged.outs[0].value);
    expect(tagged.expiryHeight).toBe(expiry);
    if (name === "native PKH") {
      expect(untagged.outs[0].script.toString("hex")).toMatch(/^76a914[0-9a-f]{40}88ac$/);
      expect(script.paramsOptCC.toChunk().toString("hex")).toBe("040300010114" + recipient.destinationBytes.toString("hex"));
    } else {
      expect(script.paramsOptCC.toChunk()).toEqual(scriptOf(untagged).paramsOptCC.toChunk());
    }
    if (evalCode === EVALS.EVAL_RESERVE_TRANSFER) {
      const transfer = new ReserveTransfer();
      transfer.fromBuffer(script.paramsOptCC.vData[0]);
      expect(transfer.transferDestination.toBuffer()).toEqual(output.address.toBuffer());
      expect(transfer.firstValue().toString()).toBe("100000");
      expect(transfer.feeAmount.toString()).toBe("20000");
    } else {
      expect(script.paramsOptCC.destinations[0].toAddress()).toBe(output.address.getAddressString());
    }
    expect(unpack(tagged).values).toEqual(unpack(untagged).values);
    expect(unpack(tagged).fees).toEqual(unpack(untagged).fees);
    const [currency, satoshis] = Object.entries(output.currencies)[0];
    const bitgo = parse(smarttxs.createUnfundedCurrencyTransfer(system, [{
      ...output, currency, satoshis: String(satoshis), vdxftag: tag, bridgeid: output.exportto,
    }], networks.verus, expiry));
    expect(tagged.outs[0].script).toEqual(bitgo.outs[0].script);
    expect(tagged.outs[0].value).toBe(bitgo.outs[0].value);
  });

  test("preserves every currency in a tagged mixed native and token output", () => {
    const currencies = { [system]: "100000", [token]: "250000", [remote]: "1" };
    const output = { ...payment, currencies };
    const tagged = build([{ ...output, vdxftag: tag }]);
    const untagged = build([output]);
    expect(scriptOf(tagged).masterOptCC.toChunk().toString("hex")).toBe("04030001011505" + tagHash.toString("hex"));
    expect(scriptOf(tagged).paramsOptCC.toChunk()).toEqual(scriptOf(untagged).paramsOptCC.toChunk());
    for (const [currency, amount] of Object.entries(currencies)) {
      expect(unpack(tagged).values[currency].toString()).toBe(amount);
    }
    expect(tagged.outs[0].value).toBe(100000);
  });

  test("preserves conversion refund destinations without mutating the caller", () => {
    const output = { ...conversion, refundto: identity };
    const tagged = build([{ ...output, vdxftag: tag }]);
    expect(scriptOf(tagged).paramsOptCC.toChunk()).toEqual(scriptOf(build([output])).paramsOptCC.toChunk());
    const transfer = new ReserveTransfer();
    transfer.fromBuffer(scriptOf(tagged).paramsOptCC.vData[0]);
    expect(transfer.transferDestination.getAddressString()).toBe(recipient.getAddressString());
    expect(transfer.transferDestination.auxDests[0].getAddressString()).toBe(identity.getAddressString());
    expect(recipient.hasAuxDests()).toBe(false);
  });

  test("uses a tag resolved from a JSON-restored testnet VerusPay invoice", () => {
    const details = new VerusPayInvoiceDetails({
      requestedcurrencyid: system, amount: new BigNumber("100000"), destination: recipient,
      tag: CompactXAddressObject.fromDataKey("vrsctest::invoice.payment", "VRSCTEST"),
    });
    details.setFlags({ isTagged: true, isTestnet: true });
    const restored = VerusPayInvoice.fromJson(new VerusPayInvoice({ details }).toJson());
    const resolvedTag = restored.details.tag.toAddress();
    expect(resolvedTag).toBe(details.tag.toAddress());
    const tx = build([{ ...payment, vdxftag: resolvedTag }]);
    expect(scriptOf(tx).masterOptCC.toChunk().toString("hex")).toBe(
      "04030001011505" + fromBase58Check(resolvedTag).hash.toString("hex")
    );
  });

  test.each([true, false])("legacy invoice helper preserves tagged=%s without RPC", async isTagged => {
    const rpc = jest.fn(async () => { throw new Error("Unexpected RPC"); });
    const client = new VerusIdInterface(system, "http://offline.invalid", undefined, rpc);
    const details = new VerusPayInvoiceDetails({
      requestedcurrencyid: system, amount: new BigNumber("100000"), destination: recipient,
      tag: isTagged ? CompactXAddressObject.fromAddress(tag, "VRSCTEST") : undefined,
    });
    details.setFlags({ isTagged, isTestnet: true });
    const invoice = await client.createVerusPayInvoice(details, undefined, undefined, undefined, expiry, system);
    expect(invoice.getVersionNoFlags().toNumber()).toBe(isTagged ? 4 : 3);
    const binary = new VerusPayInvoice();
    binary.fromBuffer(invoice.toBuffer());
    const json = VerusPayInvoice.fromJson(invoice.toJson());
    for (const restored of [binary, json]) {
      expect(restored.details.isTagged()).toBe(isTagged);
      expect(restored.toBuffer()).toEqual(invoice.toBuffer());
      if (isTagged) expect(restored.details.tag.toAddress()).toBe(tag);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  test("keeps tags attached to their own outputs in a mixed payment", () => {
    const plain = build([payment]);
    const tx = build([{ ...payment, vdxftag: tag }, payment, { ...payment, vdxftag: otherTag }]);
    expect(tx.outs).toHaveLength(3);
    expect(scriptOf(tx, 0).masterOptCC.toChunk().toString("hex")).toBe("04030001011505" + tagHash.toString("hex"));
    expect(tx.outs[1].script).toEqual(plain.outs[0].script);
    expect(scriptOf(tx, 2).masterOptCC.toChunk().toString("hex")).toBe("04030001011505" + "07".repeat(20));
  });

  test.each([
    ["empty tag", ""],
    ["unresolved data key", "vrsctest::invoice.payment"],
    ["PKH prefix", toBase58Check(tagHash, 60)],
    ["identity prefix", toBase58Check(tagHash, 102)],
    ["bad checksum", tag.slice(0, -1) + (tag.endsWith("1") ? "2" : "1")],
    ["short hash", bs58check.encode(Buffer.concat([Buffer.from([137]), Buffer.alloc(19)]))],
    ["long hash", bs58check.encode(Buffer.concat([Buffer.from([137]), Buffer.alloc(21)]))],
    ["noncanonical version", bs58check.encode(Buffer.concat([Buffer.from([0, 137]), tagHash]))],
  ])("rejects an invoice %s", (_name, malformed) => {
    expect(() => build([{ ...payment, vdxftag: malformed }])).toThrow(/Invalid destination address/);
  });

  test.each([
    ["preserved", tag, true],
    ["changed", otherTag, false],
    ["removed", undefined, false],
  ] as Array<[string, string | undefined, boolean]>)("validates funding with the tag %s", (_name, resultingTag, valid) => {
    const unfunded = build([{ ...payment, vdxftag: tag }]);
    const funded = build([{ ...payment, vdxftag: resultingTag }]);
    const changeAddress = TEST_ID_2.identity.primaryaddresses[0];
    const changeDestination = new TransferDestination({ type: DEST_PKH, destinationBytes: fromBase58Check(changeAddress).hash });
    const changeScript = build([{ currencies: { [system]: "90000" }, address: changeDestination }]).outs[0].script;
    const utxo = {
      txid: "ab".repeat(32), outputIndex: 0, satoshis: 200000,
      script: changeScript.toString("hex"), isspendable: true, address: changeAddress, height: 1,
    };
    funded.addInput(Buffer.from(utxo.txid, "hex").reverse(), 0);
    funded.addOutput(changeScript, 90000);
    const result = smarttxs.validateFundedCurrencyTransfer(
      system, funded.toHex(), unfunded.toHex(), changeAddress, networks.verus, [utxo]
    );
    expect(result.valid).toBe(valid);
    if (valid) {
      expect(result.sent).toEqual({ [system]: "100000" });
      expect(result.fees).toEqual({ [system]: "10000" });
    } else {
      expect(result.message).toBe("Transaction hex does not match unfunded component.");
    }
  });
});
