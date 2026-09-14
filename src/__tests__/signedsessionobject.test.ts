import { VerusIdInterface, primitives } from '../index';

describe('Disabled signed session object creation', () => {
  test.each([undefined, 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq'])(
    'rejects without making RPC requests with chain context %s',
    async chainIAddr => {
      const rpcRequest = jest.fn(async () => {
        throw new Error('Unexpected RPC request');
      });
      const verusId = new VerusIdInterface('VRSCTEST', 'http://127.0.0.1', undefined, rpcRequest);
      const data = new primitives.SignedSessionObjectData({
        session_id: 'i8jHXEEYEQ7KEoYe6eKXBib8cUBZ6vjWSd',
        timestamp_micro: 320492835,
        body: 'test body'
      });

      await expect(verusId.createSignedSessionObject(
        'i8jHXEEYEQ7KEoYe6eKXBib8cUBZ6vjWSd',
        data,
        undefined,
        undefined,
        undefined,
        chainIAddr
      )).rejects.toThrow('SignedSessionObject is deprecated and disabled');

      expect(rpcRequest).not.toHaveBeenCalled();
    }
  );
});
