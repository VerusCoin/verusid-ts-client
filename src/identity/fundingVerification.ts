import { Output, requireCondition, transaction } from "./fundingPrimitives";

export type FundingOutpoint = {
  txid: string;
  vout: number;
};

export type FundingPrevout = FundingOutpoint & {
  rawTransaction: string;
  address?: string;
};

/** Retain these unsigned transaction bytes and source evidence independently. */
export type PreparedFundingTransaction = {
  txHex: string;
  prevouts: FundingPrevout[];
};

/** Common payment intent; each operation supplies its own output and fee rules. */
export type FundingApproval = {
  systemID: string;
  changeAddress: string;
};

/** The raw-prevout bypass is available only to explicitly configured tests. */
export function assertUnverifiedPrevoutsAllowed(enabled: boolean): void {
  if (!enabled) return;

  requireCondition(
    typeof process !== "undefined" && process.env?.NODE_ENV === "test",
    "Unverified prevouts are only allowed when NODE_ENV is test."
  );
}

/** Restrict accounting to transparent Sapling-v4 transactions. */
export function verifyTransparentTransaction(tx: any): void {
  requireCondition(
    tx &&
      tx.version === 4 &&
      tx.overwintered === 1 &&
      tx.versionGroupId === 0x892f2085 &&
      !tx.isCoinbase() &&
      !tx.joinsplits?.length &&
      !tx.vShieldedSpend?.length &&
      !tx.vShieldedOutput?.length &&
      (!tx.valueBalance || tx.valueBalance.equals(Buffer.alloc(8))),
    "Unsupported funding transaction components."
  );
}

/**
 * Bind a candidate to the retained unsigned baseline. Signature verification
 * and operation-specific lock-time/expiry rules remain the caller's concern.
 */
export function verifyFundingTransaction(
  funded: PreparedFundingTransaction,
  candidateHex: string
): any {
  const approved = transaction(funded.txHex);
  const candidate = transaction(candidateHex);
  verifyTransparentTransaction(approved);
  verifyTransparentTransaction(candidate);
  requireCondition(
    approved.ins.every((input: any) => !input.script.length),
    "Funding approval transaction must be unsigned."
  );

  const stripped = candidate.clone();
  stripped.ins.forEach((input: any) => {
    input.script = Buffer.alloc(0);
  });
  requireCondition(
    stripped.toHex() === approved.toHex(),
    "Funding transaction changed after approval."
  );

  return candidate;
}

/**
 * Bind each input to its raw source output without using cached balances.
 * trustedPrevouts is a fixture fallback restricted to NODE_ENV=test, never
 * proof that an output exists or remains unspent on the current chain.
 */
export function readFundingPrevouts(
  candidate: any,
  prevouts: FundingPrevout[],
  options: {
    allowCoinbase?: boolean;
    trustedPrevouts?: Array<FundingOutpoint & Output>;
  } = {}
): Array<FundingPrevout & { output: Output }> {
  assertUnverifiedPrevoutsAllowed(options.trustedPrevouts !== undefined);

  requireCondition(
    Array.isArray(candidate?.ins) &&
      candidate.ins.length > 0 &&
      Array.isArray(prevouts) &&
      candidate.ins.length === prevouts.length,
    "Missing or unexpected funding input."
  );

  const seen = new Set<string>();
  const sources = new Map<string, { tx: any; hex: string }>();

  return candidate.ins.map((input: any, index: number) => {
    const txid = Buffer.from(input.hash).reverse().toString("hex");
    const key = `${txid}:${input.index}`;
    const prevout = prevouts[index];
    requireCondition(
      prevout &&
        !seen.has(key) &&
        input.sequence === 0xffffffff &&
        prevout.txid === txid &&
        prevout.vout === input.index,
      "Duplicate or unexpected funding outpoint."
    );
    seen.add(key);

    let output: Output;
    if (prevout.rawTransaction) {
      let source = sources.get(txid);
      if (!source) {
        const tx = transaction(prevout.rawTransaction);
        requireCondition(
          tx.getId() === txid,
          "Funding source transaction hash or index does not match."
        );
        requireCondition(
          options.allowCoinbase === true || !tx.isCoinbase(),
          "Coinbase funding source transaction is unsupported."
        );
        source = { tx, hex: prevout.rawTransaction };
        sources.set(txid, source);
      } else {
        requireCondition(
          source.hex === prevout.rawTransaction,
          "Inconsistent funding source transaction."
        );
      }

      requireCondition(
        source.tx.outs[input.index],
        "Funding source transaction hash or index does not match."
      );
      output = source.tx.outs[input.index];
    } else {
      const trusted = options.trustedPrevouts?.[index];
      requireCondition(
        trusted && trusted.txid === txid && trusted.vout === input.index,
        "Missing raw funding source transaction."
      );
      output = { script: trusted.script, value: trusted.value };
    }

    return { ...prevout, output };
  });
}
