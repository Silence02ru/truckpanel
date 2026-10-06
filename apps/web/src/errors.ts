import type { TFunction } from 'i18next';
import { ApiRequestError } from './api';

/** Maps API error codes to translated, user-facing text (never raw exceptions). */
export function errorText(t: TFunction, error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 0) return t('errors.network');
    return t(`errors.${error.code}`, { defaultValue: t('errors.internal') });
  }
  return t('errors.internal');
}
