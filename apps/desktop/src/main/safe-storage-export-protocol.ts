/** Shared between the app (which starts the helper) and the helper itself. */
export const SAFE_STORAGE_EXPORT_ENV = 'ANTSEED_SAFE_STORAGE_EXPORT';
/** The app name whose safeStorage key the helper reads with. */
export const SAFE_STORAGE_EXPORT_NAME_ENV = 'ANTSEED_SAFE_STORAGE_EXPORT_NAME';
/** userData for the helper; on Windows the key lives in its `Local State`. */
export const SAFE_STORAGE_EXPORT_USER_DATA_ENV = 'ANTSEED_SAFE_STORAGE_EXPORT_USER_DATA';
/** Prefix of the helper's one result line on stdout. */
export const SAFE_STORAGE_EXPORT_RESULT_PREFIX = 'ANTSEED_SAFE_STORAGE_EXPORT_RESULT ';

export type SafeStorageExportRequest = { blobs: string[] };
export type SafeStorageExportResult = { available: boolean; plain: Array<string | null> };
