export function describeSdkFailure(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown error';
  const details: string[] = [];
  if ('code' in error && typeof error.code === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(error.code)) details.push(error.code);
  if ('status' in error && typeof error.status === 'number' && Number.isInteger(error.status)) details.push(`HTTP ${error.status}`);
  if (details.length) return details.join(' · ');
  return error instanceof Error ? error.message : 'unknown error';
}
