import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { DeviceId, isDeviceId, newDeviceId } from '@rcn/protocol';

const STORAGE_KEY = 'rcn.phase0.deviceId';

/**
 * Phase 0 device id. It is a random identifier, not a key, and is stored in
 * plain AsyncStorage — Phase 1 replaces it with a keypair whose private half
 * lives in the Android Keystore (ADR 0002).
 *
 * Persisting it is what makes the kill-and-reopen leg of the real-device test
 * meaningful: the same device must come back with the same identity.
 */
export async function loadOrCreateDeviceId(): Promise<DeviceId> {
  const stored = await AsyncStorage.getItem(STORAGE_KEY);
  if (isDeviceId(stored)) {
    return stored;
  }
  const created = newDeviceId((n) => Crypto.getRandomBytes(n));
  await AsyncStorage.setItem(STORAGE_KEY, created);
  return created;
}
