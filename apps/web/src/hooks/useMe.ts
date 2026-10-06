import { useMantineColorScheme } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CurrentUser, Preferences } from '@truckpanel/shared';
import { useCallback, useEffect, useRef } from 'react';
import { ApiRequestError, api } from '../api';
import { setLanguage } from '../i18n';
import { ME_KEY } from '../queryKeys';

/** /api/auth/me: the signed-in user, or null when signed out. Shared by App and useMe. */
export const meQueryOptions = {
  queryKey: ME_KEY,
  queryFn: async (): Promise<CurrentUser | null> => {
    try {
      return await api.me();
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 401) return null;
      throw e;
    }
  },
  staleTime: 30_000,
};

/** The signed-in user from the shared cache (App loads it); null when signed out. */
export function useMe(): CurrentUser | null {
  const q = useQuery(meQueryOptions);
  return q.data ?? null;
}

/** Saves language/theme to the profile so they follow the user to other browsers. */
export function useSavePreferences(): (patch: Partial<Preferences>) => void {
  const qc = useQueryClient();
  const me = useMe();
  return useCallback(
    (patch) => {
      if (!me) return;
      const next = { locale: me.locale, theme: me.theme, ...patch };
      qc.setQueryData(ME_KEY, { ...me, ...next });
      void api.savePreferences(next).then((u) => qc.setQueryData(ME_KEY, u)).catch(() => undefined);
    },
    [me, qc],
  );
}

/** Applies the profile's language and theme once per sign-in. */
export function useApplyProfilePreferences(user: CurrentUser): void {
  const { setColorScheme } = useMantineColorScheme();
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (applied.current === user.id) return;
    applied.current = user.id;
    setLanguage(user.locale);
    setColorScheme(user.theme);
  }, [user.id, user.locale, user.theme, setColorScheme]);
}
