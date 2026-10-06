import { Alert, Anchor, Badge, Button, Divider, Group, Modal, Stack, Table, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PackageVersion, ServerSummary } from '@truckpanel/shared';
import { Download, History } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { errorText } from '../../errors';
import { formatBytes } from '../../live/format';
import { SERVERS_KEY, packagesKey, serverKey } from '../../queryKeys';

/** What the uploaded pair contains, downloads and the last versions with rollback (§7.3). */
export function PackagesHistory({ server }: { server: Pick<ServerSummary, 'id' | 'state'> }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const view = useQuery({ queryKey: packagesKey(server.id), queryFn: () => api.packages(server.id) });
  const [rollback, setRollback] = useState<PackageVersion | null>(null);
  const restore = useMutation({
    mutationFn: (version: string) => api.restorePackages(server.id, version),
    onSuccess: () => {
      setRollback(null);
      void qc.invalidateQueries({ queryKey: packagesKey(server.id) });
      void qc.invalidateQueries({ queryKey: serverKey(server.id) });
      void qc.invalidateQueries({ queryKey: SERVERS_KEY });
      notifications.show({ color: 'green', message: t('packages.restored') });
    },
  });

  if (view.isError) return <Alert color="red">{errorText(t, view.error)}</Alert>;
  const v = view.data;
  if (!v) return null;
  const running = server.state === 'ONLINE' || server.state === 'STARTING';
  const short = (sha: string | null) => (sha ? sha.slice(0, 12) : '—');

  return (
    <Stack gap="sm" mt="md">
      <Divider />
      <Group justify="space-between" align="flex-start">
        <Stack gap={2}>
          <Text size="sm" fw={600}>
            {t('packages.current')}
          </Text>
          {v.current.info ? (
            <Group gap="xs">
              <Badge variant="light">{v.current.info.map ?? '—'}</Badge>
              <Badge variant="light" color="gray">
                {t('packages.dlc', { count: v.current.info.dlc })}
              </Badge>
              <Badge variant="light" color="gray">
                {t('packages.mods', { count: v.current.info.mods })}
              </Badge>
            </Group>
          ) : (
            <Text size="sm" c="dimmed">
              {t('packages.noInfo')}
            </Text>
          )}
          {v.current.uploadedAt && (
            <Text size="xs" c="dimmed">
              {t('packages.uploadedBy', { user: v.current.uploadedBy ?? '—', time: new Date(v.current.uploadedAt).toLocaleString() })}
            </Text>
          )}
          <Text size="xs" c="dimmed" className="tp-mono">
            .sii {formatBytes(v.current.sii.size)} · {short(v.current.sii.sha256)} &nbsp; .dat {formatBytes(v.current.dat.size)} · {short(v.current.dat.sha256)}
          </Text>
        </Stack>
        <Group gap="xs">
          <Button component="a" href={`/api/servers/${server.id}/packages/sii`} download variant="default" size="xs" leftSection={<Download size={14} />}>
            .sii
          </Button>
          <Button component="a" href={`/api/servers/${server.id}/packages/dat`} download variant="default" size="xs" leftSection={<Download size={14} />}>
            .dat
          </Button>
        </Group>
      </Group>

      <Group gap="xs" mt="xs">
        <History size={16} />
        <Text size="sm" fw={600}>
          {t('packages.history')}
        </Text>
      </Group>
      {v.history.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('packages.noHistory')}
        </Text>
      ) : (
        <Table className="tp-table" verticalSpacing={6}>
          <Table.Tbody>
            {v.history.map((h) => (
              <Table.Tr key={h.version}>
                <Table.Td>
                  <Text size="sm">{new Date(h.createdAt).toLocaleString()}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed" className="tp-mono">
                    .sii {formatBytes(h.sii.size)} · {short(h.sii.sha256)} · .dat {formatBytes(h.dat.size)}
                  </Text>
                </Table.Td>
                <Table.Td w={120}>
                  <Anchor component="button" size="sm" onClick={() => setRollback(h)}>
                    {t('packages.rollback')}
                  </Anchor>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      <Modal opened={rollback !== null} onClose={() => setRollback(null)} title={t('packages.rollbackTitle')}>
        <Text size="sm" mb="sm">
          {t('packages.rollbackText', { time: rollback ? new Date(rollback.createdAt).toLocaleString() : '' })}
        </Text>
        {running && (
          <Alert color="yellow" variant="light" mb="sm">
            {t('packages.restartNeeded')}
          </Alert>
        )}
        {restore.isError && (
          <Alert color="red" mb="sm">
            {errorText(t, restore.error)}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setRollback(null)}>
            {t('common.cancel')}
          </Button>
          <Button loading={restore.isPending} onClick={() => rollback && restore.mutate(rollback.version)}>
            {t('packages.rollback')}
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}
