import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Code,
  CopyButton,
  FileInput,
  Group,
  List,
  Loader,
  Menu,
  Modal,
  PasswordInput,
  Progress,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GAME_APP_IDS, GAMES, MAX_PLAYERS, type ServerDetail, type Task } from '@truckpanel/shared';
import {
  Check,
  Cpu,
  ChevronDown,
  Copy,
  Download,
  LayoutDashboard,
  CalendarClock,
  Archive,
  UsersRound,
  MessageSquare,
  Network,
  Package,
  Play,
  RotateCw,
  Search,
  Shield,
  SlidersHorizontal,
  Skull,
  Square,
  SquareTerminal,
  Trash2,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { ApiRequestError, api } from '../api';
import { PageHeader } from '../components/PageHeader';
import { StatTile } from '../components/StatTile';
import { ConfigTab } from '../components/servers/ConfigTab';
import { ModeratorsCard } from '../components/servers/ModeratorsCard';
import { DiscordTab } from '../components/servers/DiscordTab';
import { MembersTab } from '../components/servers/MembersTab';
import { BackupsTab } from '../components/servers/BackupsTab';
import { ScheduleTab } from '../components/servers/ScheduleTab';
import { PackagesHistory } from '../components/servers/PackagesHistory';
import { TaskLogModal, taskErrorText } from '../components/servers/TaskLogModal';
import { useServerAction } from '../components/servers/PowerButtons';
import { StatusBadge } from '../components/servers/StatusBadge';
import { errorText } from '../errors';
import { useCan } from '../hooks/useCan';
import { useServer } from '../hooks/useServers';
import { useLiveSubscription } from '../live/LiveProvider';
import { formatBytes } from '../live/format';
import { liveStore, useLive } from '../live/store';
import { ConsoleView } from '../components/servers/ConsoleView';
import { SERVERS_KEY, logsKey, tasksKey, packagesKey } from '../queryKeys';

function ActionsBar({ server }: { server: ServerDetail }) {
  const { t } = useTranslation();
  const can = useCan(server);
  const action = useServerAction(server.id);
  const busy = Boolean(server.activeTask) || action.isPending;
  const running = server.state === 'ONLINE' || server.state === 'STARTING';
  const canStart = !busy && !running && server.packages.sii && server.packages.dat && server.state !== 'NEW';

  return (
    <Group gap="xs">
      {can('server.power') && (
        <>
          <Button variant="default" leftSection={<Play size={16} />} disabled={!canStart} onClick={() => action.mutate('start')}>
            {t('servers.start')}
          </Button>
          <Button color="red" variant="light" leftSection={<Square size={16} />} disabled={busy || !running} onClick={() => action.mutate('stop')}>
            {t('servers.stop')}
          </Button>
          <Button variant="outline" leftSection={<RotateCw size={16} />} disabled={busy || !running} onClick={() => action.mutate('restart')}>
            {t('servers.restart')}
          </Button>
        </>
      )}
      {can('server.maintain') && (
        <Menu position="bottom-end">
          <Menu.Target>
            <Button variant="default" rightSection={<ChevronDown size={16} />} disabled={busy}>
              {t('servers.more')}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<Download size={16} />} onClick={() => action.mutate('update')}>
              {t('servers.update')}
            </Menu.Item>
            <Menu.Item leftSection={<RotateCw size={16} />} onClick={() => action.mutate('install')}>
              {t('servers.reinstall')}
            </Menu.Item>
            <Menu.Item color="red" leftSection={<Skull size={16} />} disabled={!running} onClick={() => action.mutate('kill')}>
              {t('servers.kill')}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      )}
    </Group>
  );
}

function RestartBanner({ serverId, busy }: { serverId: string; busy: boolean }) {
  const { t } = useTranslation();
  const can = useCan(serverId);
  const action = useServerAction(serverId);
  return (
    <Alert color="yellow" title={t('config.restartBannerTitle')}>
      <Group justify="space-between">
        <Text size="sm">{t('config.restartBanner')}</Text>
        {can('server.power') && (
          <Button size="xs" leftSection={<RotateCw size={14} />} disabled={busy} loading={action.isPending} onClick={() => action.mutate('restart')}>
            {t('config.restartNow')}
          </Button>
        )}
      </Group>
    </Alert>
  );
}

function ActiveTask({ task }: { task: Task }) {
  const { t } = useTranslation();
  const [logOpen, setLogOpen] = useState(false);
  return (
    <Card>
      <Group justify="space-between" mb="xs">
        <Text fw={600}>{t(`taskKind.${task.kind}`)}…</Text>
        <Group gap="sm">
          <Text size="sm" c="dimmed">
            {task.stage ?? ''} · {task.progress}%
          </Text>
          <Button size="compact-xs" variant="default" onClick={() => setLogOpen(true)}>
            {t('tasks.showLog')}
          </Button>
        </Group>
      </Group>
      <Progress value={task.progress} animated size="lg" />
      <TaskLogModal taskId={logOpen ? task.id : null} onClose={() => setLogOpen(false)} />
    </Card>
  );
}

function SessionCard({ server }: { server: ServerDetail }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const can = useCan(server);
  const [token, setToken] = useState('');
  const save = useMutation({
    mutationFn: (value: string | null) => api.setLogonToken(server.id, value),
    onSuccess: (_s, value) => {
      setToken('');
      notifications.show({ color: 'green', message: value ? t('session.tokenSaved') : t('session.tokenCleared') });
      void qc.invalidateQueries({ queryKey: SERVERS_KEY });
    },
  });
  const running = server.state === 'ONLINE' || server.state === 'STARTING';

  return (
    <Card>
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <Search size={18} />
          <Title order={4}>{t('session.title')}</Title>
        </Group>
        <Badge color={server.logonTokenSet ? 'green' : 'yellow'} variant="light">
          {server.logonTokenSet ? t('session.persistent') : t('session.temporary')}
        </Badge>
      </Group>

      <Group gap="xs" mb="sm" wrap="nowrap">
        <Text size="sm" c="dimmed">
          {t('session.searchId')}
        </Text>
        {server.sessionSearchId ? (
          <>
            <Code fz="sm">{server.sessionSearchId}</Code>
            <CopyButton value={server.sessionSearchId}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? t('session.copied') : t('session.copy')}>
                  <ActionIcon variant="subtle" color={copied ? 'green' : 'gray'} onClick={copy} aria-label={t('session.copy')}>
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          </>
        ) : (
          <Text size="sm">{t('session.noIdYet')}</Text>
        )}
      </Group>

      <Text size="sm" c="dimmed" mb="sm">
        {server.logonTokenSet ? t('session.persistentHint') : t('session.temporaryHint')}
      </Text>

      {can('server.config') && (
        <Stack gap="sm">
          <List size="sm" type="ordered" spacing={4}>
            <List.Item>
              {t('session.step1')}{' '}
              <Anchor href="https://steamcommunity.com/dev/managegameservers" target="_blank" rel="noreferrer">
                steamcommunity.com/dev/managegameservers
              </Anchor>
            </List.Item>
            <List.Item>
              {t('session.step2')} <Code>{GAME_APP_IDS[server.game]}</Code> ({GAMES[server.game].label})
            </List.Item>
            <List.Item>{t('session.step3')}</List.Item>
          </List>
          {save.isError && <Alert color="red">{errorText(t, save.error)}</Alert>}
          <Group align="flex-end">
            <PasswordInput
              label="server_logon_token"
              placeholder={server.logonTokenSet ? t('session.tokenReplace') : t('session.tokenPlaceholder')}
              value={token}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setToken(value);
              }}
              style={{ flex: 1 }}
              autoComplete="off"
            />
            <Button onClick={() => save.mutate(token.trim())} loading={save.isPending} disabled={!token.trim()}>
              {t('session.save')}
            </Button>
            {server.logonTokenSet && (
              <Button variant="default" color="red" onClick={() => save.mutate(null)} loading={save.isPending}>
                {t('session.clear')}
              </Button>
            )}
          </Group>
          {running && (
            <Text size="sm" c="dimmed">
              {t('session.restartNeeded')}
            </Text>
          )}
        </Stack>
      )}
    </Card>
  );
}

function PackagesCard({ server }: { server: ServerDetail }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const can = useCan(server);
  const [sii, setSii] = useState<File | null>(null);
  const [dat, setDat] = useState<File | null>(null);
  const upload = useMutation({
    mutationFn: () => api.uploadPackages(server.id, { sii, dat }),
    onSuccess: () => {
      setSii(null);
      setDat(null);
      notifications.show({ color: 'green', message: t('packages.uploaded') });
      void qc.invalidateQueries({ queryKey: SERVERS_KEY });
      void qc.invalidateQueries({ queryKey: packagesKey(server.id) });
    },
  });
  const ready = server.packages.sii && server.packages.dat;

  return (
    <Card>
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <Package size={18} />
          <Title order={4}>server_packages</Title>
        </Group>
        <Badge color={ready ? 'green' : 'yellow'} variant="light">
          {ready ? t('packages.ready') : t('packages.missing')}
        </Badge>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('packages.why')}
      </Text>
      <List size="sm" type="ordered" mb="md" spacing={4}>
        <List.Item>
          {t('packages.step1')} <Code>uset g_console "1"</Code>
        </List.Item>
        <List.Item>{t('packages.step2')}</List.Item>
        <List.Item>
          {t('packages.step3')} <Code>export_server_packages</Code>
        </List.Item>
        <List.Item>{t('packages.step4')}</List.Item>
      </List>
      {can('server.files') && (
        <Stack gap="sm">
          {upload.isError && <Alert color="red">{errorText(t, upload.error)}</Alert>}
          <Group grow align="flex-end">
            <FileInput
              label="server_packages.sii"
              placeholder={server.packages.sii ? t('packages.replace') : t('packages.choose')}
              accept=".sii"
              value={sii}
              onChange={setSii}
              clearable
            />
            <FileInput
              label="server_packages.dat"
              placeholder={server.packages.dat ? t('packages.replace') : t('packages.choose')}
              accept=".dat"
              value={dat}
              onChange={setDat}
              clearable
            />
          </Group>
          <Group>
            <Button onClick={() => upload.mutate()} loading={upload.isPending} disabled={!sii && !dat}>
              {t('packages.upload')}
            </Button>
            {server.state === 'ONLINE' && (
              <Text size="sm" c="dimmed">
                {t('packages.restartNeeded')}
              </Text>
            )}
          </Group>
        </Stack>
      )}
      {can('server.files') && ready && <PackagesHistory server={server} />}
    </Card>
  );
}

function TasksTable({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const tasks = useQuery({ queryKey: tasksKey(serverId), queryFn: () => api.tasks(serverId), refetchInterval: 3000 });
  const [logTask, setLogTask] = useState<string | null>(null);
  return (
    <Card p={0}>
      <Title order={4} p="md">
        {t('tasks.recent')}
      </Title>
      <Table className="tp-table" verticalSpacing="sm" horizontalSpacing="md">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('tasks.kind')}</Table.Th>
            <Table.Th>{t('tasks.state')}</Table.Th>
            <Table.Th>{t('tasks.result')}</Table.Th>
            <Table.Th>{t('tasks.when')}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(tasks.data ?? []).map((task) => (
            <Table.Tr key={task.id}>
              <Table.Td>{t(`taskKind.${task.kind}`)}</Table.Td>
              <Table.Td>
                <Badge
                  variant="light"
                  color={task.state === 'succeeded' ? 'green' : task.state === 'failed' ? 'red' : 'blue'}
                >
                  {t(`taskState.${task.state}`)}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c={task.state === 'failed' ? 'red' : 'dimmed'} lineClamp={2}>
                  {task.state === 'failed' ? taskErrorText(t, task) : (task.message ?? (task.state === 'running' ? `${task.progress}%` : ''))}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  {new Date(task.createdAt).toLocaleString()}
                </Text>
              </Table.Td>
              <Table.Td>
                <Button size="compact-xs" variant="subtle" onClick={() => setLogTask(task.id)}>
                  {t('tasks.showLog')}
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <TaskLogModal taskId={logTask} onClose={() => setLogTask(null)} />
    </Card>
  );
}

function ConsoleTab({ serverId, serverName }: { serverId: string; serverName: string }) {
  const { t } = useTranslation();
  useLiveSubscription(serverId, ['console']);
  // A stopped server has no live stream: show the last container output from REST instead.
  const history = useQuery({ queryKey: logsKey(serverId), queryFn: () => api.logs(serverId, 400), staleTime: Infinity });
  useEffect(() => {
    if (history.data && (liveStore.get().console[serverId]?.length ?? 0) === 0) {
      const ts = new Date().toISOString();
      liveStore.appendConsole(
        serverId,
        history.data.text.split('\n').filter((l) => l.trim() !== '').map((text) => ({ ts, text })),
        true,
      );
    }
  }, [history.data, serverId]);
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('console.readOnly')}
      </Text>
      {history.isError && <Alert color="red">{errorText(t, history.error)}</Alert>}
      <ConsoleView serverId={serverId} serverName={serverName} height="60vh" />
    </Stack>
  );
}

function PlayersTab({ serverId, online }: { serverId: string; online: boolean }) {
  const { t } = useTranslation();
  useLiveSubscription(serverId, ['players']);
  const players = useLive((st) => st.players[serverId]) ?? [];
  return (
    <Card p={0}>
      <Group justify="space-between" p="md">
        <Title order={4}>{t('players.title')}</Title>
        <Badge variant="light">{t('players.count', { count: players.length, max: MAX_PLAYERS })}</Badge>
      </Group>
      <Table className="tp-table" verticalSpacing="sm" horizontalSpacing="md">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('players.name')}</Table.Th>
            <Table.Th>client_id</Table.Th>
            <Table.Th>{t('players.since')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {players.map((p) => (
            <Table.Tr key={`${p.clientId}-${p.name}`}>
              <Table.Td fw={600}>{p.name}</Table.Td>
              <Table.Td className="tp-mono">{p.clientId ?? '—'}</Table.Td>
              <Table.Td>{new Date(p.connectedSince).toLocaleTimeString()}</Table.Td>
            </Table.Tr>
          ))}
          {players.length === 0 && (
            <Table.Tr>
              <Table.Td colSpan={3}>
                <Text size="sm" c="dimmed" ta="center" py="md">
                  {online ? t('players.none') : t('players.offline')}
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
        </Table.Tbody>
      </Table>
      <Text size="xs" c="dimmed" p="md">
        {t('players.source')}
      </Text>
    </Card>
  );
}

function DangerZone({ server }: { server: ServerDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [opened, modal] = useDisclosure(false);
  const [confirm, setConfirm] = useState('');
  const remove = useMutation({
    mutationFn: () => api.deleteServer(server.id, confirm),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SERVERS_KEY });
      navigate('/dashboard');
    },
  });
  return (
    <Card style={{ borderColor: 'var(--mantine-color-red-7)' }}>
      <Group justify="space-between">
        <Stack gap={2}>
          <Title order={4}>{t('danger.title')}</Title>
          <Text size="sm" c="dimmed">
            {t('danger.text')}
          </Text>
        </Stack>
        <Button color="red" variant="outline" leftSection={<Trash2 size={16} />} onClick={modal.open}>
          {t('danger.delete')}
        </Button>
      </Group>
      <Modal opened={opened} onClose={modal.close} title={t('danger.confirmTitle')} centered>
        <Stack>
          <Text size="sm">{t('danger.confirmText', { name: server.name })}</Text>
          {remove.isError && <Alert color="red">{errorText(t, remove.error)}</Alert>}
          <TextInput value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} placeholder={server.name} data-autofocus />
          <Button color="red" disabled={confirm.trim() !== server.name} loading={remove.isPending} onClick={() => remove.mutate()}>
            {t('danger.deleteForever')}
          </Button>
        </Stack>
      </Modal>
    </Card>
  );
}

/** "/map/europe.mbd" → "europe". */
function mapName(path: string | undefined): string {
  if (!path) return '—';
  return path.replace(/^.*\//, '').replace(/\.mbd$/, '');
}

export function ServerPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const can = useCan(id);
  const server = useServer(id);
  const serverMetricsAll = useLive((st) => st.serverMetrics);

  if (server.isPending) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (server.isError || !server.data) {
    const notFound = server.error instanceof ApiRequestError && server.error.status === 404;
    return <Alert color="red">{notFound ? t('errors.not_found') : errorText(t, server.error)}</Alert>;
  }
  const s = server.data;
  const metrics = serverMetricsAll[s.id];
  const lastError = s.lastError && (s.state === 'ERROR' || s.state === 'AWAITING_PACKAGES');

  return (
    <Stack gap="xl">
      <PageHeader
        eyebrow={GAMES[s.game].label}
        title={
          <Group gap="sm">
            {s.name}
            <StatusBadge state={s.state} />
          </Group>
        }
        subtitle={t('servers.subtitle', { connection: s.ports.connection, query: s.ports.query })}
        actions={<ActionsBar server={s} />}
      />

      <Tabs defaultValue="overview" keepMounted={false}>
        <Tabs.List mb="lg">
          <Tabs.Tab value="overview" leftSection={<LayoutDashboard size={16} />}>
            {t('servers.tabs.overview')}
          </Tabs.Tab>
          <Tabs.Tab value="config" leftSection={<SlidersHorizontal size={16} />}>
            {t('servers.tabs.config')}
          </Tabs.Tab>
          <Tabs.Tab value="players" leftSection={<Users size={16} />}>
            {t('servers.tabs.players')}
          </Tabs.Tab>
          <Tabs.Tab value="moderators" leftSection={<Shield size={16} />}>
            {t('servers.tabs.moderators')}
          </Tabs.Tab>
          {can('server.backups') && (
            <Tabs.Tab value="backups" leftSection={<Archive size={16} />}>
              {t('servers.tabs.backups')}
            </Tabs.Tab>
          )}
          {can('server.maintain') && (
            <Tabs.Tab value="schedule" leftSection={<CalendarClock size={16} />}>
              {t('servers.tabs.schedule')}
            </Tabs.Tab>
          )}
          <Tabs.Tab value="members" leftSection={<UsersRound size={16} />}>
            {t('servers.tabs.members')}
          </Tabs.Tab>
          {can('server.discord') && (
            <Tabs.Tab value="discord" leftSection={<MessageSquare size={16} />}>
              {t('servers.tabs.discord')}
            </Tabs.Tab>
          )}
          {can('server.console') && (
            <Tabs.Tab value="console" leftSection={<SquareTerminal size={16} />}>
              {t('servers.tabs.console')}
            </Tabs.Tab>
          )}
        </Tabs.List>

        <Tabs.Panel value="overview">
          <Stack gap="lg">
            {s.activeTask && <ActiveTask task={s.activeTask} />}
            {s.restartRequired && <RestartBanner serverId={s.id} busy={Boolean(s.activeTask)} />}
            {lastError && (
              <Alert color={s.state === 'ERROR' ? 'red' : 'yellow'} title={t(`serverState.${s.state}`)}>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  {s.lastError}
                </Text>
              </Alert>
            )}
            <div className="tp-stat-tiles">
              <StatTile
                label={t('stats.players')}
                value={s.players === null ? `— / ${MAX_PLAYERS}` : `${s.players} / ${MAX_PLAYERS}`}
                hint={t('stats.slots')}
                icon={Users}
              />
              <StatTile
                label={t('servers.ports')}
                value={`${s.ports.connection}`}
                hint={t('servers.portsDetail', { query: s.ports.query, cv: s.ports.connectionVirtual, qv: s.ports.queryVirtual })}
                icon={Network}
              />
              <StatTile
                label={t('servers.load')}
                value={metrics ? `${metrics.cpuPercent.toFixed(1)}% CPU` : '—'}
                hint={
                  metrics
                    ? t('servers.memUsage', { used: formatBytes(metrics.memUsedBytes), limit: formatBytes(metrics.memLimitBytes) })
                    : t('servers.resources', { mem: s.memoryMb, cpus: s.cpus })
                }
                icon={Cpu}
              />
              <StatTile
                // Version from the DS log; A2S "version" is 1.0.0.1 on DS 1.61 and is not shown.
                label={t('servers.gameVersion')}
                value={s.gameVersion ?? '—'}
                hint={s.query?.map ? t('servers.map', { map: mapName(s.query.map) }) : t('servers.versionHint')}
                icon={Package}
              />
            </div>
            <Alert color="gray" variant="light">
              <Text size="sm">{t('servers.slotsNote')}</Text>
            </Alert>
            <SessionCard server={s} />
            <PackagesCard server={s} />
            <TasksTable serverId={s.id} />
            {can('server.delete') && <DangerZone server={s} />}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="config">
          <ConfigTab serverId={s.id} running={s.state === 'ONLINE' || s.state === 'STARTING'} />
        </Tabs.Panel>
        <Tabs.Panel value="moderators">
          <ModeratorsCard serverId={s.id} running={s.state === 'ONLINE' || s.state === 'STARTING'} />
        </Tabs.Panel>
        <Tabs.Panel value="players">
          <PlayersTab serverId={s.id} online={s.state === 'ONLINE'} />
        </Tabs.Panel>
        <Tabs.Panel value="backups">
          <BackupsTab server={s} />
        </Tabs.Panel>
        <Tabs.Panel value="schedule">
          <ScheduleTab server={s} />
        </Tabs.Panel>
        <Tabs.Panel value="members">
          <MembersTab server={s} />
        </Tabs.Panel>
        <Tabs.Panel value="discord">
          <DiscordTab serverId={s.id} />
        </Tabs.Panel>
        <Tabs.Panel value="console">
          <ConsoleTab serverId={s.id} serverName={s.name} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
