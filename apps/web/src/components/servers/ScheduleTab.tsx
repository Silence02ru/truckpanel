import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Chip,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SCHEDULE_ACTIONS, type ScheduleInput, type ScheduleSpec, type ScheduleView, type ServerSummary } from '@truckpanel/shared';
import { CalendarClock, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { errorText } from '../../errors';
import { SERVERS_KEY, schedulesKey, serverKey } from '../../queryKeys';

const DAYS = [1, 2, 3, 4, 5, 6, 0];
const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [browserTz(), 'UTC'];
  } catch {
    return [browserTz(), 'UTC'];
  }
})();

const EMPTY: ScheduleInput = { action: 'restart', spec: { kind: 'daily', time: '05:00' }, timezone: browserTz(), enabled: true };

/** Scheduled actions and auto-restart (docs/PHASE-7.md §7.5). */
export function ScheduleTab({ server }: { server: Pick<ServerSummary, 'id' | 'autoRestart' | 'access'> }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const canSchedule = server.access.permissions.includes('server.schedule');
  const canMaintain = server.access.permissions.includes('server.maintain');
  const list = useQuery({ queryKey: schedulesKey(server.id), queryFn: () => api.schedules(server.id), enabled: canSchedule });
  const [editing, setEditing] = useState<{ id: string | null; input: ScheduleInput } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: schedulesKey(server.id) });

  const save = useMutation({
    mutationFn: (e: { id: string | null; input: ScheduleInput }) => (e.id ? api.updateSchedule(server.id, e.id, e.input) : api.createSchedule(server.id, e.input)),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (s: ScheduleView) => api.deleteSchedule(server.id, s.id),
    onSuccess: refresh,
    onError: (e) => notifications.show({ color: 'red', message: errorText(t, e) }),
  });
  const toggle = useMutation({
    mutationFn: (s: ScheduleView) => api.updateSchedule(server.id, s.id, { action: s.action, spec: s.spec, timezone: s.timezone, enabled: !s.enabled }),
    onSuccess: refresh,
    onError: (e) => notifications.show({ color: 'red', message: errorText(t, e) }),
  });
  const autoRestart = useMutation({
    mutationFn: (enabled: boolean) => api.setAutoRestart(server.id, enabled),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: serverKey(server.id) });
      void qc.invalidateQueries({ queryKey: SERVERS_KEY });
    },
    onError: (e) => notifications.show({ color: 'red', message: errorText(t, e) }),
  });

  const describe = (spec: ScheduleSpec) => {
    if (spec.kind === 'interval') return t('schedule.everyHours', { count: spec.hours });
    if (spec.kind === 'daily') return t('schedule.dailyAt', { time: spec.time });
    return t('schedule.weeklyAt', { days: DAYS.filter((d) => spec.days.includes(d)).map((d) => t(`schedule.day.${d}`)).join(', '), time: spec.time });
  };

  return (
    <Stack gap="lg">
      <Card>
        <Switch
          label={t('schedule.autoRestart')}
          description={t('schedule.autoRestartHint')}
          checked={server.autoRestart}
          disabled={!canMaintain || autoRestart.isPending}
          onChange={(e) => autoRestart.mutate(e.currentTarget.checked)}
        />
      </Card>

      {canSchedule && (
        <Card>
          <Group justify="space-between" mb={4}>
            <Group gap="xs">
              <CalendarClock size={18} />
              <Title order={4}>{t('schedule.title')}</Title>
            </Group>
            <Button leftSection={<Plus size={16} />} onClick={() => setEditing({ id: null, input: { ...EMPTY, timezone: browserTz() } })}>
              {t('schedule.add')}
            </Button>
          </Group>
          <Text size="sm" c="dimmed" mb="md">
            {t('schedule.intro')}
          </Text>
          {list.isError && <Alert color="red">{errorText(t, list.error)}</Alert>}
          {(list.data ?? []).length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('schedule.none')}
            </Text>
          ) : (
            <Table className="tp-table" verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('schedule.action')}</Table.Th>
                  <Table.Th>{t('schedule.when')}</Table.Th>
                  <Table.Th>{t('schedule.next')}</Table.Th>
                  <Table.Th>{t('schedule.last')}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(list.data ?? []).map((s) => (
                  <Table.Tr key={s.id}>
                    <Table.Td>
                      <Badge variant="light">{t(`schedule.actions.${s.action}`)}</Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{describe(s.spec)}</Text>
                      <Text size="xs" c="dimmed">
                        {s.timezone}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '—'}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : '—'}</Text>
                      {s.lastResult && (
                        <Text size="xs" c={s.lastResult.startsWith('failed') ? 'red' : 'dimmed'}>
                          {t(`schedule.result.${s.lastResult.split(':')[0]}`, { defaultValue: s.lastResult })}
                          {s.lastResult.includes(':') ? ` (${s.lastResult.split(':').slice(1).join(':')})` : ''}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td w={150}>
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <Switch size="xs" checked={s.enabled} onChange={() => toggle.mutate(s)} aria-label={t('schedule.enabled')} />
                        <Tooltip label={t('schedule.edit')}>
                          <ActionIcon variant="subtle" onClick={() => setEditing({ id: s.id, input: { action: s.action, spec: s.spec, timezone: s.timezone, enabled: s.enabled } })}>
                            <Pencil size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label={t('schedule.delete')}>
                          <ActionIcon variant="subtle" color="red" onClick={() => remove.mutate(s)}>
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
            {t('schedule.noWarning')}
          </Text>
        </Card>
      )}

      <Modal opened={editing !== null} onClose={() => setEditing(null)} title={editing?.id ? t('schedule.edit') : t('schedule.add')}>
        {editing && (
          <ScheduleForm
            value={editing.input}
            onChange={(input) => setEditing({ ...editing, input })}
            error={save.isError ? errorText(t, save.error) : null}
            saving={save.isPending}
            onSubmit={() => save.mutate(editing)}
          />
        )}
      </Modal>
    </Stack>
  );
}

function ScheduleForm({
  value,
  onChange,
  error,
  saving,
  onSubmit,
}: {
  value: ScheduleInput;
  onChange: (v: ScheduleInput) => void;
  error: string | null;
  saving: boolean;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const spec = value.spec;
  const setSpec = (s: ScheduleSpec) => onChange({ ...value, spec: s });
  const time = spec.kind === 'interval' ? '05:00' : spec.time;
  return (
    <Stack>
      <Select
        label={t('schedule.action')}
        data={SCHEDULE_ACTIONS.map((a) => ({ value: a, label: t(`schedule.actions.${a}`) }))}
        value={value.action}
        onChange={(a) => a && onChange({ ...value, action: a as ScheduleInput['action'] })}
        allowDeselect={false}
      />
      <Select
        label={t('schedule.repeat')}
        data={[
          { value: 'daily', label: t('schedule.kinds.daily') },
          { value: 'weekly', label: t('schedule.kinds.weekly') },
          { value: 'interval', label: t('schedule.kinds.interval') },
        ]}
        value={spec.kind}
        allowDeselect={false}
        onChange={(k) => {
          if (k === 'daily') setSpec({ kind: 'daily', time });
          if (k === 'weekly') setSpec({ kind: 'weekly', days: [1, 2, 3, 4, 5, 6, 0], time });
          if (k === 'interval') setSpec({ kind: 'interval', hours: 6 });
        }}
      />
      {spec.kind === 'weekly' && (
        <Chip.Group multiple value={spec.days.map(String)} onChange={(v) => setSpec({ ...spec, days: v.map(Number) })}>
          <Group gap={6}>
            {DAYS.map((d) => (
              <Chip key={d} value={String(d)} size="xs">
                {t(`schedule.day.${d}`)}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      )}
      {spec.kind !== 'interval' ? (
        <TextInput label={t('schedule.time')} type="time" value={spec.time} onChange={(e) => setSpec({ ...spec, time: e.currentTarget.value })} />
      ) : (
        <NumberInput label={t('schedule.hours')} min={1} max={168} value={spec.hours} onChange={(h) => setSpec({ kind: 'interval', hours: Number(h) || 1 })} />
      )}
      <Select label={t('schedule.timezone')} data={ZONES} searchable value={value.timezone} onChange={(z) => z && onChange({ ...value, timezone: z })} allowDeselect={false} />
      <Switch label={t('schedule.enabled')} checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.currentTarget.checked })} />
      {error && <Alert color="red">{error}</Alert>}
      <Group justify="flex-end">
        <Button loading={saving} onClick={onSubmit} disabled={spec.kind === 'weekly' && spec.days.length === 0}>
          {t('profile.save')}
        </Button>
      </Group>
    </Stack>
  );
}
