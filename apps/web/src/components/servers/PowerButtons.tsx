import { ActionIcon, Group, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServerAction, ServerSummary } from '@truckpanel/shared';
import { Play, RotateCw, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { errorText } from '../../errors';
import { useCan } from '../../hooks/useCan';
import { SERVERS_KEY } from '../../queryKeys';

export function useServerAction(serverId: string) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: ServerAction) => api.serverAction(serverId, action),
    onSuccess: (_task, action) => {
      notifications.show({ message: `${t(`taskKind.${action}`)} — ${t('servers.actionQueued')}` });
      void qc.invalidateQueries({ queryKey: SERVERS_KEY });
    },
    onError: (e) => notifications.show({ color: 'red', message: errorText(t, e) }),
  });
}

/** OVH-style compact power controls used in the server table. */
export function PowerButtons({ server }: { server: ServerSummary }) {
  const { t } = useTranslation();
  const can = useCan(server);
  const action = useServerAction(server.id);
  const busy = Boolean(server.activeTask) || action.isPending;
  const running = server.state === 'ONLINE' || server.state === 'STARTING';
  if (!can('server.power')) return null;
  return (
    <Group gap={6} wrap="nowrap">
      {running ? (
        <Tooltip label={t('servers.stop')}>
          <ActionIcon variant="outline" color="red" size="lg" disabled={busy} onClick={() => action.mutate('stop')} aria-label={t('servers.stop')}>
            <Square size={16} />
          </ActionIcon>
        </Tooltip>
      ) : (
        <Tooltip label={t('servers.start')}>
          <ActionIcon
            variant="outline"
            color="green"
            size="lg"
            disabled={busy || server.state === 'AWAITING_PACKAGES' || server.state === 'NEW'}
            onClick={() => action.mutate('start')}
            aria-label={t('servers.start')}
          >
            <Play size={16} />
          </ActionIcon>
        </Tooltip>
      )}
      <Tooltip label={t('servers.restart')}>
        <ActionIcon
          variant="outline"
          color="orange"
          size="lg"
          disabled={busy || !running}
          onClick={() => action.mutate('restart')}
          aria-label={t('servers.restart')}
        >
          <RotateCw size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
