import { Anchor, Badge, Button, Card, Progress, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { GAMES, MAX_PLAYERS, type ServerSummary } from '@truckpanel/shared';
import { Cpu, HardDrive, MemoryStick, Plus, Server, Settings, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { PageHeader } from '../components/PageHeader';
import { StatTile } from '../components/StatTile';
import { CreateServerModal } from '../components/servers/CreateServerModal';
import { PowerButtons } from '../components/servers/PowerButtons';
import { StatusBadge } from '../components/servers/StatusBadge';
import { useCan } from '../hooks/useCan';
import { useMe } from '../hooks/useMe';
import { useServers } from '../hooks/useServers';
import { formatBytes, percent } from '../live/format';
import { useLive } from '../live/store';
import { MetricBars } from '../components/servers/MetricBars';

const COLUMNS = ['server', 'game', 'connection', 'status', 'load', 'metrics', 'power', 'manage'] as const;

function PlayersBar({ server }: { server: ServerSummary }) {
  const { t } = useTranslation();
  if (server.players === null) {
    return (
      <Text size="sm" c="dimmed">
        — / {MAX_PLAYERS}
      </Text>
    );
  }
  return (
    <Stack gap={4} w={140}>
      <Text size="sm">{t('servers.playersOf', { count: server.players, max: MAX_PLAYERS })}</Text>
      <Progress value={(server.players / MAX_PLAYERS) * 100} size="sm" />
    </Stack>
  );
}

function TaskLine({ server }: { server: ServerSummary }) {
  const { t } = useTranslation();
  const task = server.activeTask;
  if (!task) return null;
  return (
    <Stack gap={2} mt={6} w={160}>
      <Text size="xs" c="dimmed">
        {t(`taskKind.${task.kind}`)} · {task.progress}%
      </Text>
      <Progress value={task.progress} size="xs" animated />
    </Stack>
  );
}

export function DashboardPage() {
  const { t } = useTranslation();
  const can = useCan();
  const me = useMe();
  const servers = useServers();
  const hostMetrics = useLive((st) => st.host);
  const serverMetrics = useLive((st) => st.serverMetrics);
  const [createOpen, createModal] = useDisclosure(false);
  const list = servers.data ?? [];
  const online = list.filter((s) => s.state === 'ONLINE');
  const players = online.reduce((sum, s) => sum + (s.players ?? 0), 0);
  const host = window.location.hostname;

  return (
    <Stack gap="xl">
      <PageHeader
        eyebrow={t('dashboard.eyebrow')}
        title={t('dashboard.title')}
        subtitle={
          me?.quota
            ? t('dashboard.quota', { used: me.usage.servers, total: me.quota.servers, mem: me.usage.memoryMb, memTotal: me.quota.memoryMb })
            : t('dashboard.subtitle')
        }
        actions={
          can('server.create') && (
            <Button leftSection={<Plus size={18} />} onClick={createModal.open}>
              {t('dashboard.addServer')}
            </Button>
          )
        }
      />

      <div className="tp-stat-tiles">
        <StatTile
          label={t('stats.servers')}
          value={`${online.length} / ${list.length}`}
          hint={t('stats.serversHint', { count: list.length - online.length })}
          icon={Server}
        />
        <StatTile label={t('stats.players')} value={String(players)} hint={t('stats.slots')} icon={Users} />
        {me?.quota ? (
          // Users do not get host metrics (administrators only): show their own quota instead.
          <>
            <StatTile
              label={t('stats.quotaServers')}
              value={`${me.usage.servers} / ${me.quota.servers}`}
              hint={t('stats.quotaHint')}
              icon={Server}
            />
            <StatTile
              label={t('stats.quotaResources')}
              value={`${me.usage.memoryMb} / ${me.quota.memoryMb} MB`}
              hint={t('stats.quotaCpu', { used: me.usage.cpus, total: me.quota.cpus })}
              icon={MemoryStick}
            />
            <StatTile
              label={t('stats.quotaBackups')}
              value={`${me.usage.backupMb} / ${me.quota.backupMb} MB`}
              hint={t('stats.quotaHint')}
              icon={HardDrive}
            />
          </>
        ) : (
          <>
            <StatTile
              label={t('stats.cpu')}
              value={hostMetrics ? `${hostMetrics.cpuPercent.toFixed(1)}%` : '—'}
              hint={hostMetrics ? t('stats.cores', { count: hostMetrics.cpuCores }) : t('stats.waiting')}
              icon={Cpu}
            />
            <StatTile
              label={t('stats.memory')}
              value={hostMetrics ? formatBytes(hostMetrics.memUsedBytes) : '—'}
              hint={
                hostMetrics
                  ? t('stats.ofTotal', { total: formatBytes(hostMetrics.memTotalBytes), pct: Math.round(percent(hostMetrics.memUsedBytes, hostMetrics.memTotalBytes)) })
                  : t('stats.waiting')
              }
              icon={MemoryStick}
            />
            <StatTile
              label={t('stats.disk')}
              value={hostMetrics ? formatBytes(hostMetrics.diskFreeBytes) : '—'}
              hint={hostMetrics ? t('stats.diskOf', { total: formatBytes(hostMetrics.diskTotalBytes) }) : t('stats.waiting')}
              icon={HardDrive}
            />
          </>
        )}
      </div>

      <Card p={0}>
        <Title order={3} p="lg">
          {t('dashboard.gameServers')}
        </Title>
        <Table.ScrollContainer minWidth={1100}>
          <Table className="tp-table" verticalSpacing="md" horizontalSpacing="lg">
            <Table.Thead>
              <Table.Tr>
                {COLUMNS.map((c) => (
                  <Table.Th key={c}>{t(`dashboard.columns.${c}`)}</Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((s) => (
                <Table.Tr key={s.id}>
                  <Table.Td>
                    <Anchor component={Link} to={`/servers/${s.id}`} fw={600} c="var(--mantine-color-text)">
                      {s.name}
                    </Anchor>
                    {s.owner && s.access.role !== 'owner' && (
                      <Text size="xs" c="dimmed">
                        {t('dashboard.owner', { username: s.owner.username })}
                      </Text>
                    )}
                    <TaskLine server={s} />
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={GAMES[s.game].label}>
                      <Badge variant="default">{s.game.toUpperCase()}</Badge>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={t('servers.portsHint', { query: s.ports.query })}>
                      <Text size="sm" className="tp-mono">
                        {host}:{s.ports.connection}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    <StatusBadge state={s.state} />
                  </Table.Td>
                  <Table.Td>
                    <PlayersBar server={s} />
                  </Table.Td>
                  <Table.Td>
                    <MetricBars metrics={serverMetrics[s.id]} />
                  </Table.Td>
                  <Table.Td>
                    <PowerButtons server={s} />
                  </Table.Td>
                  <Table.Td>
                    <Button component={Link} to={`/servers/${s.id}`} variant="default" size="xs" leftSection={<Settings size={14} />}>
                      {t('servers.open')}
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
              {list.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={COLUMNS.length}>
                    <Stack align="center" gap={6} py="xl">
                      <Server size={28} strokeWidth={1.5} color="var(--mantine-color-dimmed)" />
                      <Text fw={600}>{t('dashboard.emptyTitle')}</Text>
                      <Text size="sm" c="dimmed" ta="center">
                        {t('dashboard.emptyText')}
                      </Text>
                      {can('server.create') && (
                        <Button mt="sm" leftSection={<Plus size={16} />} onClick={createModal.open}>
                          {t('dashboard.addServer')}
                        </Button>
                      )}
                    </Stack>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
      <CreateServerModal opened={createOpen} onClose={createModal.close} />
    </Stack>
  );
}
