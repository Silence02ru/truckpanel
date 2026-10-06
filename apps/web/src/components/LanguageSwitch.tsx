import { SegmentedControl } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useSavePreferences } from '../hooks/useMe';
import { LANGUAGES, setLanguage, type Language } from '../i18n';

export function LanguageSwitch() {
  const { i18n, t } = useTranslation();
  const save = useSavePreferences();
  return (
    <SegmentedControl
      size="xs"
      aria-label={t('common.language')}
      value={i18n.language}
      onChange={(v) => {
        setLanguage(v as Language);
        save({ locale: v as Language });
      }}
      data={LANGUAGES.map((l) => ({ value: l, label: l.toUpperCase() }))}
    />
  );
}
