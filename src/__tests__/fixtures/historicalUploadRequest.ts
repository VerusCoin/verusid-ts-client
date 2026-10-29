/**
 * Make a payload-only request from the historical daemon upload fixture.
 * Its labels and MIME types remain in the captured transaction, allowing the
 * verifier tests to reject metadata that was not requested. The original JSON
 * is preserved so parser tests can reject its unsupported per-leaf fields.
 */
export function historicalUploadPayloadRequest<T extends {
  contentmultimap: {
    [key: string]: { data: { mmrdata: Array<{ message: string }> } };
  };
}>(json: T) {
  return {
    ...json,
    contentmultimap: Object.fromEntries(
      Object.entries(json.contentmultimap).map(([key, upload]) => [key, {
        ...upload,
        data: {
          ...upload.data,
          mmrdata: upload.data.mmrdata.map(({ message }) => ({ message })),
        },
      }])
    ),
  };
}
