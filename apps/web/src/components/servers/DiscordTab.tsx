import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Modal,
  PasswordInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DISCORD_SECTIONS,
  DISCORD_WEBHOOK_RE,
  type DiscordLocale,
  type DiscordSections,
  type DiscordState,
  type DiscordView,
} from '@truckpanel/shared';
import { MessageSquare, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { errorText } from '../../errors';
import { discordKey } from '../../queryKeys';

const INTERVALS = [30, 60, 120, 300, 600, 1800, 3600];

const STATE_COLOR: Record<DiscordState, string> = { disabled: 'gray', pending: 'blue', ok: 'green', error: 'red' };

interface Form {
  enabled: boolean;
  webhookUrl: string;
  intervalSec: number;
  locale: DiscordLocale;
  sections: DiscordSections;
  notifyStatus: boolean;
}

const toForm = (v: DiscordView): Form => ({
  enabled: v.enabled,
  webhookUrl: '',
  intervalSec: v.intervalSec,
  locale: v.locale,
  sections: v.sections,
  notifyStatus: v.notifyStatus,
});

/** Self-updating Discord status message for one server (PLAN.md §14). */
export function DiscordTab({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const view = useQuery({ queryKey: discordKey(serverId), queryFn: () => api.discord(serverId), refetchInterval: 15_000 });
  const [form, setForm] = useState<Form | null>(null);
  const [confirmOpen, confirm] = useDisclosure(false);

  useEffect(() => {
    if (view.data && form === null) setForm(toForm(view.data));
  }, [view.data, form]);

  const onSaved = (v: DiscordView) => {
    qc.setQueryData(discordKey(serverId), v);
    setForm(toForm(v));
  };
  const save = useMutation({
    mutationFn: (f: Form) =>
      api.saveDiscord(serverId, {
        enabled: f.enabled,
        intervalSec: f.intervalSec,
        locale: f.locale,
        sections: f.sections,
        notifyStatus: f.notifyStatus,
        ...(f.webhookUrl.trim() ? { webhookUrl: f.webhookUrl.trim() } : {}),
      }),
    onSuccess: (v) => {
      onSaved(v);
      notifications.show({ color: 'green', message: t('discord.saved') });
    },
  });
  const refresh = useMutation({
    mutationFn: () => api.refreshDiscord(serverId),
    onSuccess: (v) => qc.setQueryData(discordKey(serverId), v),
    onError: (e) => notifications.show({ color: 'red', message: errorText(t, e) }),
  });
  const remove = useMutation({
    mutationFn: () => api.removeDiscord(serverId),
    onSuccess: async () => {
      confirm.close();
      setForm(null);
      await qc.invalidateQueries({ queryKey: discordKey(serverId) });
      notifications.show({ color: 'green', message: t('discord.removed') });
    },
    onError: (e) => notifications.show({ color: 'red', message: errorText(t, e) }),
  });

  if (view.isError) return <Alert color="red">{errorText(t, view.error)}</Alert>;
  if (!view.data || !form) return null;
  const v = view.data;
  const urlInvalid = form.webhookUrl.trim() !== '' && !DISCORD_WEBHOOK_RE.test(form.webhookUrl.trim());
  const needsUrl = form.enabled && !v.webhookSet && form.webhookUrl.trim() === '';
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm({ ...form, [key]: value });

  return (
    <Stack gap="lg">
      <Card>
        <Group justify="space-between" mb="xs">
          <Group gap="xs">
            <MessageSquare size={18} />
            <Title order={4}>{t('discord.title')}</Title>
          </Group>
          <Badge color={STATE_COLOR[v.state]} variant="light">
            {t(`discord.state.${v.state}`)}
          </Badge>
        </Group>
        <Text size="sm" c="dimmed" mb="md">
          {t('discord.intro')}
        </Text>

        {v.lastErrorCode && (
          <Alert color={v.state === 'error' ? 'red' : 'yellow'} mb="md">
            {t(`errors.${v.lastErrorCode}`)}
          </Alert>
        )}
        {v.lastSuccessAt && (
          <Text size="xs" c="dimmed" mb="md">
            {t('discord.lastSuccess', { time: new Date(v.lastSuccessAt).toLocaleString() })}
          </Text>
        )}

        <Stack gap="md">
          <Switch label={t('discord.enabled')} checked={form.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />
          <PasswordInput
            label={t('discord.webhook')}
            description={v.webhookSet ? t('discord.webhookKept', { id: v.webhookId }) : t('discord.webhookHelp')}
            placeholder={v.webhookSet ? t('discord.webhookSetPlaceholder') : 'https://discord.com/api/webhooks/…'}
            value={form.webhookUrl}
            onChange={(e) => set('webhookUrl', e.currentTarget.value)}
            error={urlInvalid ? t('discord.urlFormat') : needsUrl ? t('errors.discord.not_configured') : undefined}
            autoComplete="off"
          />
          <Group grow align="flex-start">
            <Select
              label={t('discord.interval')}
              data={INTERVALS.map((s) => ({ value: String(s), label: t('discord.every', { value: s < 60 ? `${s} ${t('discord.sec')}` : `${s / 60} ${t('discord.min')}` }) }))}
              value={String(form.intervalSec)}
              onChange={(val) => val && set('intervalSec', Number(val))}
              allowDeselect={false}
            />
            <div>
              <Text size="sm" fw={500} mb={4}>
                {t('discord.language')}
              </Text>
              <SegmentedControl
                value={form.locale}
                onChange={(val) => set('locale', val as DiscordLocale)}
                data={[
                  { value: 'ru', label: 'Русский' },
                  { value: 'en', label: 'English' },
                ]}
              />
            </div>
          </Group>

          <div>
            <Text size="sm" fw={500} mb={6}>
              {t('discord.sections')}
            </Text>
            <Text size="xs" c="dimmed" mb="sm">
              {t('discord.sectionsHint')}
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
              {DISCORD_SECTIONS.map((key) => (
                <Checkbox
                  key={key}
                  label={t(`discord.section.${key}`)}
                  checked={form.sections[key]}
                  onChange={(e) => set('sections', { ...form.sections, [key]: e.currentTarget.checked })}
                />
              ))}
            </SimpleGrid>
          </div>

          <Switch
            label={t('discord.notifyStatus')}
            description={t('discord.notifyStatusHint')}
            checked={form.notifyStatus}
            onChange={(e) => set('notifyStatus', e.currentTarget.checked)}
          />

          {save.isError && <Alert color="red">{errorText(t, save.error)}</Alert>}
          <Group justify="space-between">
            <Group>
              <Button onClick={() => save.mutate(form)} loading={save.isPending} disabled={urlInvalid || needsUrl}>
                {t('discord.save')}
              </Button>
              <Button
                variant="default"
                leftSection={<RefreshCw size={16} />}
                onClick={() => refresh.mutate()}
                loading={refresh.isPending}
                disabled={!v.enabled || !v.webhookSet}
              >
                {t('discord.refresh')}
              </Button>
            </Group>
            {v.webhookSet && (
              <Button color="red" variant="subtle" leftSection={<Trash2 size={16} />} onClick={confirm.open}>
                {t('discord.remove')}
              </Button>
            )}
          </Group>
        </Stack>
      </Card>

      <Modal opened={confirmOpen} onClose={confirm.close} title={t('discord.removeTitle')}>
        <Text size="sm" mb="lg">
          {t('discord.removeText')}
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={confirm.close}>
            {t('common.cancel')}
          </Button>
          <Button color="red" onClick={() => remove.mutate()} loading={remove.isPending}>
            {t('discord.remove')}
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}
