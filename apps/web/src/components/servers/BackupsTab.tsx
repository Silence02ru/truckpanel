import { ActionIcon, Alert, Badge, Button, Card, FileButton, Group, Modal, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BACKUP_KEEP, type BackupView, type ServerSummary } from '@truckpanel/shared';
import { Archive, Download, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { errorText } from '../../errors';
import { formatBytes } from '../../live/format';
import { SERVERS_KEY, backupsKey, serverKey, tasksKey } from '../../queryKeys';

const KIND_COLOR: Record<BackupView['kind'], string> = { manual: 'blue', scheduled: 'gray', 'pre-restore': 'yellow', uploaded: 'grape' };

/** Server backups (docs/PHASE-7.md §7.4). */
export function BackupsTab({ server }: { server: Pick<ServerSummary, 'id' | 'state' | 'activeTask'> }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: backupsKey(server.id), queryFn: () => api.backups(server.id), refetchInterval: server.activeTask ? 2000 : false });
  const [restoreOf, setRestoreOf] = useState<BackupView | null>(null);
  const [deleteOf, setDeleteOf] = useState<BackupView | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: backupsKey(server.id) });
    void qc.invalidateQueries({ queryKey: tasksKey(server.id) });
    void qc.invalidateQueries({ queryKey: serverKey(server.id) });
    void qc.invalidateQueries({ queryKey: SERVERS_KEY });
  };
  const onError = (e: unknown) => notifications.show({ color: 'red', message: errorText(t, e) });

  const create = useMutation({
    mutationFn: () => api.createBackup(server.id),
    onSuccess: () => {
      notifications.show({ message: t('backups.started') });
      refresh();
    },
    onError,
  });
  const restore = useMutation({
    mutationFn: (b: BackupView) => api.restoreBackup(server.id, b.id),
    onSuccess: () => {
      setRestoreOf(null);
      notifications.show({ message: t('backups.restoreStarted') });
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (b: BackupView) => api.deleteBackup(server.id, b.id),
    onSuccess: () => {
      setDeleteOf(null);
      refresh();
    },
  });
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadBackup(server.id, file),
    onSuccess: () => {
      notifications.show({ color: 'green', message: t('backups.uploaded') });
      refresh();
    },
    onError,
  });
  const busy = Boolean(server.activeTask);
  const running = server.state === 'ONLINE' || server.state === 'STARTING';

  return (
    <Stack gap="lg">
      <Card>
        <Group justify="space-between" mb={4}>
          <Group gap="xs">
            <Archive size={18} />
            <Title order={4}>{t('backups.title')}</Title>
          </Group>
          <Group gap="xs">
            <FileButton onChange={(f) => f && upload.mutate(f)} accept=".tar.gz,.tgz,application/gzip">
              {(props) => (
                <Button {...props} variant="default" leftSection={<Upload size={16} />} loading={upload.isPending}>
                  {t('backups.upload')}
                </Button>
              )}
            </FileButton>
            <Button leftSection={<Archive size={16} />} onClick={() => create.mutate()} loading={create.isPending} disabled={busy}>
              {t('backups.create')}
            </Button>
          </Group>
        </Group>
        <Text size="sm" c="dimmed" mb="md">
          {t('backups.intro', { keep: BACKUP_KEEP })}
        </Text>
        {list.isError && <Alert color="red">{errorText(t, list.error)}</Alert>}
        {(list.data ?? []).length === 0 && !list.isPending ? (
          <Text size="sm" c="dimmed">
            {t('backups.none')}
          </Text>
        ) : (
          <Table className="tp-table" verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('backups.when')}</Table.Th>
                <Table.Th>{t('backups.kind')}</Table.Th>
                <Table.Th>{t('backups.size')}</Table.Th>
                <Table.Th>{t('backups.gameVersion')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(list.data ?? []).map((b) => (
                <Table.Tr key={b.id}>
                  <Table.Td>
                    <Text size="sm">{new Date(b.createdAt).toLocaleString()}</Text>
                    <Text size="xs" c="dimmed">
                      {b.createdBy ?? t('backups.system')}
                      {b.note ? ` · ${b.note}` : ''}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge variant="light" color={KIND_COLOR[b.kind]}>
                      {t(`backups.kinds.${b.kind}`)}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{formatBytes(b.sizeBytes)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{b.gameVersion ?? '—'}</Text>
                  </Table.Td>
                  <Table.Td w={140}>
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      <Tooltip label={t('backups.restore')}>
                        <ActionIcon variant="subtle" onClick={() => setRestoreOf(b)} disabled={busy} aria-label={t('backups.restore')}>
                          <RotateCcw size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label={t('backups.download')}>
                        <ActionIcon component="a" href={`/api/servers/${server.id}/backups/${b.id}/download`} variant="subtle" color="gray" aria-label={t('backups.download')}>
                          <Download size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label={t('backups.delete')}>
                        <ActionIcon variant="subtle" color="red" onClick={() => setDeleteOf(b)} aria-label={t('backups.delete')}>
                          <Trash2 size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        <Text size="xs" c="dimmed" mt="md">
          {t('backups.contents')}
        </Text>
      </Card>

      <Modal opened={restoreOf !== null} onClose={() => setRestoreOf(null)} title={t('backups.restoreTitle')}>
        <Stack>
          <Text size="sm">{t('backups.restoreText', { time: restoreOf ? new Date(restoreOf.createdAt).toLocaleString() : '' })}</Text>
          {running && (
            <Alert color="yellow" variant="light">
              {t('backups.restoreRunning')}
            </Alert>
          )}
          {restore.isError && <Alert color="red">{errorText(t, restore.error)}</Alert>}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRestoreOf(null)}>
              {t('common.cancel')}
            </Button>
            <Button loading={restore.isPending} onClick={() => restoreOf && restore.mutate(restoreOf)}>
              {t('backups.restore')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={deleteOf !== null} onClose={() => setDeleteOf(null)} title={t('backups.deleteTitle')}>
        <Stack>
          <Text size="sm">{t('backups.deleteText')}</Text>
          {remove.isError && <Alert color="red">{errorText(t, remove.error)}</Alert>}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteOf(null)}>
              {t('common.cancel')}
            </Button>
            <Button color="red" loading={remove.isPending} onClick={() => deleteOf && remove.mutate(deleteOf)}>
              {t('backups.delete')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
