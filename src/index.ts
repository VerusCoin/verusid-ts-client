import VerusIdInterface from "./VerusIdInterface";
import * as primitives from "verus-typescript-primitives";

export type {
  AddressUtxo,
  AddressUtxos,
  CurrencyTransferOutput,
  IdentityUpdateCurrencyTransferOptions,
  IdentityUpdateTransactionResult
} from "./VerusIdInterface";

export type {
  ResolveIdentityRegistrationRequest,
  ResolvedIdentityRegistration,
  IdentityReservationRecord,
  CreateNameReservationTransactionRequest,
  CreateIdentityRegistrationTransactionRequest,
  PreparedIdentityRegistrationTransaction,
  SignIdentityRegistrationTransactionArgs,
  MergeIdentityRegistrationTransactionsArgs,
  NameReservationTransactionResult
} from "./identity/registration";
export { RegistrationError } from "./identity/registrationPolicy";
export {
  verifyRegistrationFunding,
  verifyIdentityRegistrationFunding
} from "./identity/registrationFundingVerification";
export type { RegistrationFundingApproval } from "./identity/registrationFundingVerification";
export type {
  IdentityRegistrationPolicy,
  IdentityRegistrationQuote,
  RegistrationPayment,
  RegistrationPaymentBranch,
  RegistrationReferralEvidence
} from "./identity/registrationPolicy";
export type {
  RegistrationAmounts,
  RegistrationChainSnapshot,
  RegistrationFundingInput,
  RegistrationPrevout,
  RegistrationPlannedOutput
} from "./identity/registrationTransaction";
export type {
  RegistrationSigningPrevout,
  RegistrationIdentityAuthority,
  InspectIdentityRegistrationSignaturesArgs,
  RegistrationDestinationSignatureStatus,
  RegistrationInputSignatureStatus,
  IdentityRegistrationSigningResult
} from "./identity/registrationSigning";

export {
  VerusIdInterface,
  primitives
}
