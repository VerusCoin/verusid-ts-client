import { VerusIdInterface, primitives } from '../../index'
import { TEST_ID, VERUSTEST_I_ADDR } from '../fixtures/verusid';
import { TransferDestination, DEST_PKH, fromBase58Check } from 'verus-typescript-primitives';

describe('Creates and validates VerusPay v3+ invoices', () => {
  const VerusId = new VerusIdInterface("VRSCTEST", "https://api.verus.services")

  test('can create basic VerusPay v3 invoice', async () => {
    const req = await VerusId.createVerusPayInvoice(
      new primitives.VerusPayInvoiceDetails({
        amount: new primitives.BigNumber(10000000000, 10),
        destination: new TransferDestination({
          type: DEST_PKH,
          destination_bytes: fromBase58Check("R9J8E2no2HVjQmzX6Ntes2ShSGcn7WiRcx").hash
        }),
        requestedcurrencyid: "iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq"
      }),
      undefined,
      undefined,
      undefined,
      18167,
      VERUSTEST_I_ADDR
    );

    expect(req.toQrString()).toBe("dgCq8t3nk3reqeFQANTiwij8jmIDMAGkn67HAAIUAC0zEcOL_SGQktKu9EmAS-izvv6m756iNWNeMoEk_zQp25-ekbZOLQ");
  });

  test('can create, sign, and verify a basic VerusPay v3 invoice', async () => {
    const inv = await VerusId.createVerusPayInvoice(
      new primitives.VerusPayInvoiceDetails({
        amount: new primitives.BigNumber(10000000000, 10),
        destination: new TransferDestination({
          type: DEST_PKH,
          destination_bytes: fromBase58Check("R9J8E2no2HVjQmzX6Ntes2ShSGcn7WiRcx").hash
        }),
        requestedcurrencyid: "iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq"
      }),
      "i8jHXEEYEQ7KEoYe6eKXBib8cUBZ6vjWSd",
      "UrEJQMk9PD4Fo9i8FNb1ZSFRrC9TrD4j6CGbFvbFHVH83bStroHH",
      TEST_ID,
      18167,
      VERUSTEST_I_ADDR
    );

    const invoiceuri = inv.toWalletDeeplinkUri();
    const rebuiltinvoice = primitives.VerusPayInvoice.fromWalletDeeplinkUri(invoiceuri);

    expect(await VerusId.verifySignedVerusPayInvoice(
      rebuiltinvoice,
      TEST_ID,
      VERUSTEST_I_ADDR
    )).toBe(true)
  });
});
