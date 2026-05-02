import 'fake-indexeddb/auto';

/**
 * jsdom's URL.createObjectURL rejects anything that isn't a real Blob, but
 * fake-indexeddb's structured-clone of a stored Blob produces a plain
 * Object that no longer carries the Blob prototype. Production code in real
 * browsers doesn't have this problem; we stub the helpers in tests so the
 * cache-invalidation paths can be exercised without env friction.
 */
let _id = 0;
const _urls = new Map<string, unknown>();
URL.createObjectURL = ((obj: unknown) => {
  const url = `blob:test/${++_id}`;
  _urls.set(url, obj);
  return url;
}) as typeof URL.createObjectURL;
URL.revokeObjectURL = ((url: string) => {
  _urls.delete(url);
}) as typeof URL.revokeObjectURL;
