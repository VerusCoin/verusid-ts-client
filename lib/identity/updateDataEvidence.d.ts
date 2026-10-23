import { CrossChainProof } from "verus-typescript-primitives";
type Output = {
    script: Buffer;
    value: number;
};
export type IdentityUpdateEvidence = {
    proof: CrossChainProof;
    outputIndexes: number[];
};
/** Read the daemon's evidence groups, preserving their starting output indexes. */
export declare function readIdentityUpdateEvidence(outputs: Output[], expectedSystemId?: string): Map<number, IdentityUpdateEvidence>;
export {};
