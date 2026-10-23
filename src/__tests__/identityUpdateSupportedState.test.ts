import BN from "bn.js";
import { Transaction, networks, smarttxs } from "@bitgo/utxo-lib";
import {
  Identity,
  IdentityScript,
  IdentityUpdateRequestDetails,
  PartialIdentity,
  TransferDestination,
  DEST_PKH,
  fromBase58Check,
} from "verus-typescript-primitives";
import { VerusIdInterface } from "../index";
import { verifyIdentityDefinitionOutput } from "../identity/updateFundingVerification";
import { TEST_ID_3, VERUSTEST_I_ADDR } from "./fixtures/verusid";

const HEIGHT = 30000;
const CHANGE = TEST_ID_3.identity.primaryaddresses[0];
// Encode a legacy payload directly: the modern script factory deliberately
// refuses to construct historical versions, but readers must reject them too.
function identityScript(identity: Identity): IdentityScript {
  const script = IdentityScript.fromIdentity(Identity.fromJson(TEST_ID_3.identity));
  script.paramsOptCC.vData[0] = identity.toBuffer();
  return script;
}
function template(identity: Identity): string {
  const tx = Transaction.fromHex(smarttxs.createUnfundedIdentityUpdate(
    Identity.fromJson(TEST_ID_3.identity).toBuffer().toString("hex"),
    networks.verus,
    HEIGHT + 20
  ), networks.verus);
  tx.outs[0].script = identityScript(identity).toBuffer();
  return tx.toHex();
}

describe("unverified identity state fails closed throughout update APIs", () => {
  test.each([1, 2])("rejects version %i identity definitions in approvals", (version) => {
    const identity = Identity.fromJson(TEST_ID_3.identity);
    identity.version = new BN(version);
    const output = { value: 0, script: identityScript(identity).toBuffer() };
    for (const canonical of [false, true]) {
      expect(() => verifyIdentityDefinitionOutput(output, identity.getIdentityAddress(), canonical))
        .toThrow(/version|legacy|pre-v3/i);
    }
  });

  test.each(
    [1, 2].flatMap(version =>
      ["full", "partial", "supplied"].flatMap(kind =>
        ["plain", "combined"].map(mode => [version, kind, mode] as const)
      )
    )
  )("rejects legacy source v%i for %s/%s before funding", async (version, kind, mode) => {
    const source = Identity.fromJson(TEST_ID_3.identity);
    source.version = new BN(version);
    const updated = Identity.fromJson(TEST_ID_3.identity);
    const request = kind === "full" ? updated : new IdentityUpdateRequestDetails({
      identity: new PartialIdentity({ name: source.name, parent: source.parent }),
    });
    const rpc = jest.fn(async (): Promise<any> => { throw new Error("Unexpected RPC"); });
    const client = new VerusIdInterface(VERUSTEST_I_ADDR, "https://offline.invalid", undefined, rpc);
    const supplied = kind === "supplied" ? template(updated) : undefined;
    const run = () => mode === "plain"
      ? client.createUpdateIdentityTransaction(
        request, CHANGE, template(source), HEIGHT - 1, [], VERUSTEST_I_ADDR,
        undefined, undefined, HEIGHT, supplied, false, true
      )
      : client.createUpdateIdentityWithCurrencyTransferTransaction(
        request, CHANGE, template(source), HEIGHT - 1,
        [{
          currencies: { [VERUSTEST_I_ADDR]: "1" },
          address: new TransferDestination({
            type: DEST_PKH, destinationBytes: fromBase58Check(CHANGE).hash,
          }),
        }], [], {
          currentHeight: HEIGHT, chainIAddr: VERUSTEST_I_ADDR, isTestnet: true,
          updateIdentityTransactionHex: supplied,
        }
      );
    await expect(run()).rejects.toThrow(/version|legacy|pre-v3/i);
    await expect(run()).rejects.toThrow(/version|legacy|pre-v3/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([1, 2])("does not silently upgrade a requested full version %i identity", async (version) => {
    const source = Identity.fromJson(TEST_ID_3.identity);
    const updated = Identity.fromJson(TEST_ID_3.identity);
    updated.version = new BN(version);
    const rpc = jest.fn(async (): Promise<any> => { throw new Error("Unexpected RPC"); });
    const client = new VerusIdInterface(VERUSTEST_I_ADDR, "https://offline.invalid", undefined, rpc);
    await expect(client.createUpdateIdentityTransaction(
      updated, CHANGE, template(source), HEIGHT - 1, [], VERUSTEST_I_ADDR,
      undefined, undefined, HEIGHT
    )).rejects.toThrow(/version|legacy|pre-v3/i);
    expect(updated.version.toNumber()).toBe(version);
    expect(rpc).not.toHaveBeenCalled();
  });
});
