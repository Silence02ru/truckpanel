import { ActionIcon, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSavePreferences } from '../hooks/useMe';

export function ThemeToggle() {
  const { t } = useTranslation();
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('dark');
  const save = useSavePreferences();
  const label = scheme === 'dark' ? t('common.lightTheme') : t('common.darkTheme');
  return (
    <Tooltip label={label}>
      <ActionIcon
        variant="subtle"
        color="gray"
        size="lg"
        aria-label={label}
        onClick={() => {
          const next = scheme === 'dark' ? 'light' : 'dark';
          setColorScheme(next);
          save({ theme: next });
        }}
      >
        {scheme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
      </ActionIcon>
    </Tooltip>
  );
}
