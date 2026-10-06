import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  PasswordInput,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PASSWORD_MIN, type CurrentUser, type Theme, type UiLocale } from '@truckpanel/shared';
import { KeyRound, LogOut, Monitor, Palette, Shield, UserRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { PageHeader } from '../components/PageHeader';
import { errorText } from '../errors';
import { useMe, useSavePreferences } from '../hooks/useMe';
import { setLanguage } from '../i18n';
import { ME_KEY, SESSIONS_KEY } from '../queryKeys';

/** Profile settings (docs/PHASE-7.md §7.1). */
export function ProfilePage() {
  const { t } = useTranslation();
  const me = useMe();
  if (!me) return null;
  return (
    <Stack gap="xl">
      <PageHeader eyebrow={t('profile.eyebrow')} title={t('profile.title')} subtitle={t('profile.subtitle')} />
      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        <AccountCard me={me} />
        <PasswordCard />
        <PreferencesCard me={me} />
        <SteamCard me={me} />
      </SimpleGrid>
      <SessionsCard />
    </Stack>
  );
}

function CardTitle({ icon: Icon, title, hint }: { icon: typeof UserRound; title: string; hint?: string }) {
  return (
    <Stack gap={2} mb="md">
      <Group gap="xs">
        <Icon size={18} />
        <Title order={4}>{title}</Title>
      </Group>
      {hint && (
        <Text size="sm" c="dimmed">
          {hint}
        </Text>
      )}
    </Stack>
  );
}

function AccountCard({ me }: { me: CurrentUser }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [username, setUsername] = useState(me.username);
  const [email, setEmail] = useState(me.email);
  const [password, setPassword] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.changeAccount({
        currentPassword: password,
        ...(username !== me.username ? { username } : {}),
        ...(email !== me.email ? { email } : {}),
      }),
    onSuccess: (u) => {
      qc.setQueryData(ME_KEY, u);
      setPassword('');
      notifications.show({ color: 'green', message: t('profile.account.saved') });
    },
  });
  const changed = username !== me.username || email !== me.email;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (changed && password) save.mutate();
  };
  return (
    <Card>
      <CardTitle icon={UserRound} title={t('profile.account.title')} hint={t(`shell.role.${me.role}`)} />
      <form onSubmit={submit}>
        <Stack gap="sm">
          <TextInput label={t('profile.account.username')} value={username} onChange={(e) => setUsername(e.currentTarget.value)} autoComplete="username" />
          <TextInput label={t('profile.account.email')} type="email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} autoComplete="email" />
          {changed && (
            <PasswordInput
              label={t('profile.currentPassword')}
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              autoComplete="current-password"
            />
          )}
          {save.isError && <Alert color="red">{errorText(t, save.error)}</Alert>}
          <Group>
            <Button type="submit" disabled={!changed || !password} loading={save.isPending}>
              {t('profile.save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}

function PasswordCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const save = useMutation({
    mutationFn: () => api.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: (r) => {
      setCurrent('');
      setNext('');
      setRepeat('');
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
      notifications.show({ color: 'green', message: t('profile.password.saved', { count: r.revokedSessions }) });
    },
  });
  const tooShort = next.length > 0 && next.length < PASSWORD_MIN;
  const mismatch = repeat.length > 0 && repeat !== next;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (current && next.length >= PASSWORD_MIN && next === repeat) save.mutate();
  };
  return (
    <Card>
      <CardTitle icon={KeyRound} title={t('profile.password.title')} hint={t('profile.password.hint')} />
      <form onSubmit={submit}>
        <Stack gap="sm">
          <PasswordInput label={t('profile.currentPassword')} value={current} onChange={(e) => setCurrent(e.currentTarget.value)} autoComplete="current-password" />
          <PasswordInput
            label={t('profile.password.new')}
            value={next}
            onChange={(e) => setNext(e.currentTarget.value)}
            autoComplete="new-password"
            error={tooShort ? t('profile.password.tooShort', { min: PASSWORD_MIN }) : undefined}
          />
          <PasswordInput
            label={t('profile.password.repeat')}
            value={repeat}
            onChange={(e) => setRepeat(e.currentTarget.value)}
            autoComplete="new-password"
            error={mismatch ? t('profile.password.mismatch') : undefined}
          />
          {save.isError && <Alert color="red">{errorText(t, save.error)}</Alert>}
          <Group>
            <Button type="submit" disabled={!current || next.length < PASSWORD_MIN || next !== repeat} loading={save.isPending}>
              {t('profile.password.submit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}

function PreferencesCard({ me }: { me: CurrentUser }) {
  const { t } = useTranslation();
  const save = useSavePreferences();
  const { setColorScheme } = useMantineColorScheme();
  return (
    <Card>
      <CardTitle icon={Palette} title={t('profile.preferences.title')} hint={t('profile.preferences.hint')} />
      <Stack gap="md">
        <div>
          <Text size="sm" fw={500} mb={4}>
            {t('common.language')}
          </Text>
          <SegmentedControl
            value={me.locale}
            onChange={(v) => {
              setLanguage(v as UiLocale);
              save({ locale: v as UiLocale });
            }}
            data={[
              { value: 'ru', label: 'Русский' },
              { value: 'en', label: 'English' },
            ]}
          />
        </div>
        <div>
          <Text size="sm" fw={500} mb={4}>
            {t('profile.preferences.theme')}
          </Text>
          <SegmentedControl
            value={me.theme}
            onChange={(v) => {
              setColorScheme(v as Theme);
              save({ theme: v as Theme });
            }}
            data={[
              { value: 'dark', label: t('common.darkTheme') },
              { value: 'light', label: t('common.lightTheme') },
            ]}
          />
        </div>
      </Stack>
    </Card>
  );
}

function SteamCard({ me }: { me: CurrentUser }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [input, setInput] = useState('');
  const link = useMutation({
    mutationFn: () => api.linkSteam(input.trim()),
    onSuccess: (u) => {
      qc.setQueryData(ME_KEY, u);
      setInput('');
      notifications.show({ color: 'green', message: t('profile.steam.linked', { name: u.steamName ?? u.steamId64 }) });
    },
  });
  const unlink = useMutation({
    mutationFn: api.unlinkSteam,
    onSuccess: (u) => qc.setQueryData(ME_KEY, u),
    onError: (e) => notifications.show({ color: 'red', message: errorText(t, e) }),
  });
  return (
    <Card>
      <CardTitle icon={Shield} title={t('profile.steam.title')} hint={t('profile.steam.hint')} />
      {me.steamId64 ? (
        <Group justify="space-between">
          <Stack gap={0}>
            <Anchor href={`https://steamcommunity.com/profiles/${me.steamId64}`} target="_blank" rel="noreferrer noopener" fw={600}>
              {me.steamName ?? me.steamId64}
            </Anchor>
            <Text size="xs" c="dimmed" className="tp-mono">
              {me.steamId64}
            </Text>
          </Stack>
          <Button variant="subtle" color="red" onClick={() => unlink.mutate()} loading={unlink.isPending}>
            {t('profile.steam.unlink')}
          </Button>
        </Group>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) link.mutate();
          }}
        >
          <Group align="flex-start">
            <TextInput
              style={{ flex: 1 }}
              placeholder="https://steamcommunity.com/id/…"
              value={input}
              onChange={(e) => setInput(e.currentTarget.value)}
              error={link.isError ? errorText(t, link.error) : undefined}
            />
            <Button type="submit" loading={link.isPending} disabled={!input.trim()}>
              {t('profile.steam.link')}
            </Button>
          </Group>
        </form>
      )}
    </Card>
  );
}

/** Short device description from the User-Agent (no tracking libraries). */
function device(ua: string | null, t: (k: string) => string): string {
  if (!ua) return t('profile.sessions.unknownDevice');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return [browser, os].filter(Boolean).join(' · ') || ua.slice(0, 60);
}

function SessionsCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: SESSIONS_KEY, queryFn: api.sessions });
  const refresh = () => void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
  const revoke = useMutation({ mutationFn: api.revokeSession, onSuccess: refresh, onError: (e) => notifications.show({ color: 'red', message: errorText(t, e) }) });
  const revokeOthers = useMutation({
    mutationFn: api.revokeOtherSessions,
    onSuccess: (r) => {
      refresh();
      notifications.show({ color: 'green', message: t('profile.sessions.revoked', { count: r.revokedSessions }) });
    },
  });
  const list = sessions.data ?? [];
  return (
    <Card p={0}>
      <Group justify="space-between" p="md">
        <Group gap="xs">
          <Monitor size={18} />
          <Title order={4}>{t('profile.sessions.title')}</Title>
        </Group>
        <Button variant="default" size="xs" leftSection={<LogOut size={14} />} disabled={list.length < 2} onClick={() => revokeOthers.mutate()} loading={revokeOthers.isPending}>
          {t('profile.sessions.revokeOthers')}
        </Button>
      </Group>
      {sessions.isError && <Alert color="red">{errorText(t, sessions.error)}</Alert>}
      <Table.ScrollContainer minWidth={640}>
        <Table className="tp-table" verticalSpacing="sm" horizontalSpacing="md">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('profile.sessions.device')}</Table.Th>
              <Table.Th>IP</Table.Th>
              <Table.Th>{t('profile.sessions.signedIn')}</Table.Th>
              <Table.Th>{t('profile.sessions.lastSeen')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {list.map((s) => (
              <Table.Tr key={s.id}>
                <Table.Td>
                  <Group gap="xs" wrap="nowrap">
                    <Tooltip label={s.userAgent ?? ''} disabled={!s.userAgent}>
                      <Text size="sm">{device(s.userAgent, t)}</Text>
                    </Tooltip>
                    {s.current && (
                      <Badge size="sm" variant="light" color="green">
                        {t('profile.sessions.current')}
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" className="tp-mono">
                    {s.ip ?? '—'}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {new Date(s.createdAt).toLocaleString()}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {new Date(s.lastSeenAt).toLocaleString()}
                  </Text>
                </Table.Td>
                <Table.Td>
                  {!s.current && (
                    <Tooltip label={t('profile.sessions.revoke')}>
                      <ActionIcon variant="subtle" color="red" onClick={() => revoke.mutate(s.id)} aria-label={t('profile.sessions.revoke')}>
                        <LogOut size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}
