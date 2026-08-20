import { PermissionsAndroid, Platform } from 'react-native';

/**
 * Nearby's permission set splits at API 31 (Bluetooth) and API 33 (Wi-Fi).
 * Requesting a permission the platform does not define returns `never_ask_again`
 * and looks like a denial, so the list is built per API level.
 */
function requiredPermissions(): string[] {
  const api = Number(Platform.Version);
  const permissions: string[] = [];

  if (api >= 31) {
    permissions.push(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    );
  }
  if (api >= 33) {
    permissions.push(PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES);
  } else {
    permissions.push(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  }
  return permissions;
}

export interface PermissionResult {
  granted: boolean;
  denied: string[];
}

export async function requestNearbyPermissions(): Promise<PermissionResult> {
  if (Platform.OS !== 'android') {
    return { granted: false, denied: ['unsupported platform'] };
  }

  const results = await PermissionsAndroid.requestMultiple(requiredPermissions() as never[]);
  const denied = Object.entries(results)
    .filter(([, status]) => status !== PermissionsAndroid.RESULTS.GRANTED)
    .map(([name]) => name.replace('android.permission.', ''));

  return { granted: denied.length === 0, denied };
}
