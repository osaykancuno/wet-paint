import type { ConnectSessionStorage } from '@rareprotocol/connect';

// SDK game keys omit the wallet. Its supported storage adapter lets
// us isolate game authorization and pending-consent records without copying SDK
// internals. Connect session credentials themselves keep their SDK-owned keys.
export function accountStorage(storage: ConnectSessionStorage, address: () => string | undefined): ConnectSessionStorage {
  function scopedKey(key: string): string {
    if (!key.startsWith('superrare.connect.game-')) return key;
    const owner = address()?.toLowerCase();
    return `studio-games:wallet:${owner ?? 'signed-out'}:${key}`;
  }
  return {
    getItem: (key) => storage.getItem(scopedKey(key)),
    setItem: (key, value) => storage.setItem(scopedKey(key), value),
    removeItem: (key) => storage.removeItem(scopedKey(key)),
  };
}
