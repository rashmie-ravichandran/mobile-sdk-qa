import type { SdkDriver } from '../contract/types.js';
import { androidDriver } from './androidSdk.js';
import { iosDriver } from './iosSdk.js';

// In the real setup these two entries would be thin clients for the native
// runners (instrumented tests on Android, XCTest on iOS) that read the same
// scenario file and hand back result JSON. Here they are in-process stand-ins.
export const drivers: SdkDriver[] = [androidDriver, iosDriver];
