import { ActionIcon, Alert, Anchor, Avatar, Button, Card, Group, Stack, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Shield, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { errorText } from '../../errors';
import { useCan } from '../../hooks/useCan';
import { useMe } from '../../hooks/useMe';
import { SERVERS_KEY, moderatorsKey } from '../../queryKeys';

/** Session moderators by Steam profile link (PLAN.md §11.1). */
export function ModeratorsCard({ serverId, running }: { serverId: string; running: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const can = useCan(serverId);
  const editable = can('server.moderators');
  const [input, setInput] = useState('');
  const me = useMe();
  const list = useQuery({ queryKey: moderatorsKey(serverId), queryFn: () => api.moderators(serverId) });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: moderatorsKey(serverId) });
    void qc.invalidateQueries({ queryKey: SERVERS_KEY });
  };
  const add = useMutation({
    mutationFn: () => api.addModerator(serverId, input.trim()),
    onSuccess: (m) => {
      setInput('');
      notifications.show({ color: 'green', message: t('moderators.added', { name: m.name ?? m.steamId64 }) });
      refresh();
    },
  });
  const addMe = useMutation({
    mutationFn: () => api.addMeAsModerator(serverId),
    onSuccess: (m) => {
      notifications.show({ color: 'green', message: t('moderators.added', { name: m.name ?? m.steamId64 }) });
      refresh();
    },
    onError: (e) => notifications.show({ color: 'red', message: errorText(t, e) }),
  });
  const remove = useMutation({
    mutationFn: (steamId64: string) => api.removeModerator(serverId, steamId64),
    onSuccess: refresh,
    onError: (e) => notifications.show({ color: 'red', message: errorText(t, e) }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (input.trim()) add.mutate();
  };

  return (
    <Card>
      <Group gap="xs">
        <Shield size={18} />
        <Title order={4}>{t('moderators.title')}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        {t('moderators.intro')}
      </Text>

      {editable && (
        <form onSubmit={submit}>
          <Group align="flex-start" mb="md">
            <TextInput
              style={{ flex: 1 }}
              placeholder="https://steamcommunity.com/id/…"
              description={t('moderators.inputHint')}
              value={input}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setInput(value);
              }}
              error={add.isError ? errorText(t, add.error) : undefined}
            />
            <Button type="submit" loading={add.isPending} disabled={!input.trim()}>
              {t('moderators.add')}
            </Button>
            {me?.steamId64 && !(list.data ?? []).some((m) => m.steamId64 === me.steamId64) && (
              <Button variant="default" onClick={() => addMe.mutate()} loading={addMe.isPending}>
                {t('moderators.addMe')}
              </Button>
            )}
          </Group>
        </form>
      )}

      {list.isError && <Alert color="red">{errorText(t, list.error)}</Alert>}
      <Stack gap="xs">
        {(list.data ?? []).map((m) => (
          <Group key={m.steamId64} justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap">
              <Avatar radius="xl" size={32} color="amber">
                {(m.name ?? '?').slice(0, 1).toUpperCase()}
              </Avatar>
              <Stack gap={0}>
                <Text size="sm" fw={600}>
                  {m.name ?? t('moderators.unknownName')}
                </Text>
                <Anchor href={m.profileUrl} target="_blank" rel="noreferrer" size="xs" className="tp-mono">
                  {m.steamId64}
                </Anchor>
              </Stack>
            </Group>
            {editable && (
              <Tooltip label={t('moderators.remove')}>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  onClick={() => remove.mutate(m.steamId64)}
                  loading={remove.isPending && remove.variables === m.steamId64}
                  aria-label={t('moderators.remove')}
                >
                  <Trash2 size={16} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        ))}
        {list.data?.length === 0 && (
          <Text size="sm" c="dimmed">
            {t('moderators.empty')}
          </Text>
        )}
      </Stack>
      {running && (list.data?.length ?? 0) > 0 && (
        <Text size="xs" c="dimmed" mt="sm">
          {t('moderators.applyOnRestart')}
        </Text>
      )}
    </Card>
  );
}
