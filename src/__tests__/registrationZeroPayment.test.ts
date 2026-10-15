import {
  EVALS,
  IdentityID,
  SmartTransactionScript,
  TokenOutput,
} from "verus-typescript-primitives";
import {
  paymentOutput,
  readFundingOutput,
} from "../identity/registrationTransaction";

const system = new IdentityID(Buffer.alloc(20, 1)).toAddress()!;
const token = new IdentityID(Buffer.alloc(20, 2)).toAddress()!;
const recipient = new IdentityID(Buffer.alloc(20, 3)).toAddress()!;

describe("zero-amount registration reserve payments", () => {
  test.each(["issuer-payment", "referral"] as const)(
    "retains the token denomination for %s",
    (role) => {
      const output = paymentOutput(recipient, { [token]: "0" }, system, role);
      const bytes = Buffer.from(output.scriptHex, "hex");
      const script = new SmartTransactionScript();
      script.fromBuffer(bytes);
      expect(script.paramsOptCC.evalCode.toNumber()).toBe(
        EVALS.EVAL_RESERVE_OUTPUT
      );
      const payload = script.paramsOptCC.getParamObject()!;
      expect(payload.toString("hex")).toBe("01" + "02".repeat(20) + "00");
      const decoded = new TokenOutput();
      expect(decoded.fromBuffer(payload)).toBe(payload.length);
      expect(decoded.toBuffer()).toEqual(payload);
      expect(decoded.firstCurrency()).toBe(token);
      expect(decoded.firstValue()!.isZero()).toBe(true);
      expect(readFundingOutput(bytes, 0, system)).toEqual({
        [system]: "0",
        [token]: "0",
      });
    }
  );

  test("omits zero balances from ordinary change", () => {
    const output = paymentOutput(
      recipient,
      { [token]: "0", [system]: "10" },
      system,
      "change"
    );
    const script = new SmartTransactionScript();
    script.fromBuffer(Buffer.from(output.scriptHex, "hex"));
    expect(script.paramsOptCC.evalCode.toNumber()).toBe(EVALS.EVAL_NONE);
    expect(
      readFundingOutput(Buffer.from(output.scriptHex, "hex"), 10, system)
    ).toEqual({ [system]: "10" });
  });
});
