import { ActionIcon, Badge, Box, Group, ScrollArea, Tabs, Text, Tooltip } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { ChevronDown, ChevronUp, SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCan } from '../hooks/useCan';
import { useServers } from '../hooks/useServers';
import { useLiveSubscription } from '../live/LiveProvider';
import { useLive } from '../live/store';
import { ConsoleView } from './servers/ConsoleView';

function ServerConsole({ serverId, name }: { serverId: string; name: string }) {
  useLiveSubscription(serverId, ['console']);
  return <ConsoleView serverId={serverId} serverName={name} height={210} />;
}

function Activity() {
  const { t } = useTranslation();
  const activity = useLive((s) => s.activity);
  const servers = useServers().data ?? [];
  const name = (id: string) => servers.find((s) => s.id === id)?.name ?? id.slice(0, 8);
  return (
    <ScrollArea h={240} className="tp-log" type="auto">
      {activity.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('dock.noActivity')}
        </Text>
      ) : (
        [...activity].reverse().map((a, i) => (
          <div key={i}>
            <span style={{ opacity: 0.55 }}>[{new Date(a.ts).toLocaleTimeString()}]</span> <b>{name(a.serverId)}</b>: {a.text}
          </div>
        ))
      )}
    </ScrollArea>
  );
}

/** OVH game-panel style console docked at the bottom: Activity + one tab per running server. */
export function ConsoleDock() {
  const { t } = useTranslation();
  const [open, setOpen] = useLocalStorage({ key: 'tp_dock_open', defaultValue: false });
  const [tab, setTab] = useLocalStorage<string>({ key: 'tp_dock_tab', defaultValue: 'activity' });
  const status = useLive((s) => s.status);
  const running = (useServers().data ?? []).filter((s) => s.state === 'ONLINE' || s.state === 'STARTING');
  const current = tab === 'activity' || running.some((s) => s.id === tab) ? tab : 'activity';

  return (
    <Box
      style={{
        position: 'sticky',
        bottom: 0,
        zIndex: 10,
        marginTop: 'var(--mantine-spacing-xl)',
        background: 'light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))',
        border: '1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))',
        borderRadius: 'var(--mantine-radius-md) var(--mantine-radius-md) 0 0',
      }}
    >
      <Tabs value={current} onChange={(v) => v && (setTab(v), setOpen(true))}>
        <Group justify="space-between" wrap="nowrap" pr="xs">
          <Tabs.List style={{ flex: 1, overflowX: 'auto', flexWrap: 'nowrap' }}>
            <Tabs.Tab value="activity" leftSection={<SquareTerminal size={14} />}>
              {t('dock.activity')}
            </Tabs.Tab>
            {running
              .filter((s) => s.access.permissions.includes('server.console'))
              .map((s) => (
                <Tabs.Tab key={s.id} value={s.id} leftSection={<SquareTerminal size={14} />}>
                  {s.name}
                </Tabs.Tab>
              ))}
          </Tabs.List>
          <Group gap="xs" wrap="nowrap">
            <Badge size="xs" variant="dot" color={status === 'online' ? 'green' : status === 'connecting' ? 'yellow' : 'red'}>
              {t(`dock.live.${status}`)}
            </Badge>
            <Tooltip label={open ? t('dock.collapse') : t('dock.expand')}>
              <ActionIcon variant="subtle" color="gray" onClick={() => setOpen(!open)} aria-label={open ? t('dock.collapse') : t('dock.expand')}>
                {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
        {open && (
          <Box p="xs">
            {current === 'activity' ? (
              <Activity />
            ) : (
              <ServerConsole serverId={current} name={running.find((s) => s.id === current)?.name ?? ''} />
            )}
          </Box>
        )}
      </Tabs>
    </Box>
  );
}
