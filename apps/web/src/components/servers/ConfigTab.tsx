import {
  Alert,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Modal,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CONFIG_FIELDS, CONFIG_GROUPS, type ConfigField, type ConfigUpdate, type ConfigView } from '@truckpanel/shared';
import { CircleHelp } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { errorText } from '../../errors';
import { useCan } from '../../hooks/useCan';
import { SERVERS_KEY, configKey } from '../../queryKeys';
import { useServerAction } from './PowerButtons';

type Values = ConfigView['values'];

function FieldLabel({ field }: { field: ConfigField }) {
  const { t } = useTranslation();
  const tooltip = t(`config.fields.${field.key}.tooltip`, { defaultValue: '' });
  return (
    <Group gap={4} wrap="nowrap">
      <span>{t(`config.fields.${field.key}.label`)}</span>
      {tooltip && (
        <Tooltip label={tooltip} multiline w={280}>
          <CircleHelp size={14} color="var(--mantine-color-dimmed)" />
        </Tooltip>
      )}
    </Group>
  );
}

function FieldInput({
  field,
  values,
  setValue,
  password,
  setPassword,
  passwordSet,
  disabled,
}: {
  field: ConfigField;
  values: Values;
  setValue: (key: keyof Values, value: unknown) => void;
  password: string | undefined;
  setPassword: (v: string | undefined) => void;
  passwordSet: boolean;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const description = t(`config.fields.${field.key}.desc`);
  const label = <FieldLabel field={field} />;
  const key = field.key as keyof Values;

  switch (field.type) {
    case 'boolean':
      return (
        <Switch
          label={label}
          description={description}
          checked={Boolean(values[key])}
          onChange={(e) => setValue(key, e.currentTarget.checked)}
          disabled={disabled}
        />
      );
    case 'string':
      return (
        <TextInput
          label={label}
          description={description}
          maxLength={field.maxLength}
          value={String(values[key] ?? '')}
          onChange={(e) => {
            const value = e.currentTarget.value;
            setValue(key, value);
          }}
          rightSection={
            <Text size="xs" c="dimmed">
              {String(values[key] ?? '').length}/{field.maxLength}
            </Text>
          }
          rightSectionWidth={52}
          disabled={disabled}
        />
      );
    case 'secret':
      return (
        <Stack gap={4}>
          <PasswordInput
            label={label}
            description={description}
            maxLength={field.maxLength}
            placeholder={passwordSet ? t('config.passwordKeep') : t('config.passwordNone')}
            value={password ?? ''}
            onChange={(e) => {
              const value = e.currentTarget.value;
              setPassword(value === '' ? undefined : value);
            }}
            autoComplete="new-password"
            disabled={disabled}
          />
          {passwordSet && !disabled && (
            <Button variant="subtle" size="compact-xs" color="red" w="fit-content" onClick={() => setPassword('')}>
              {password === '' ? t('config.passwordWillClear') : t('config.passwordClear')}
            </Button>
          )}
        </Stack>
      );
    case 'integer':
      return (
        <NumberInput
          label={label}
          description={description}
          min={field.min}
          max={field.max}
          allowDecimal={false}
          allowNegative={false}
          value={Number(values[key])}
          onChange={(v) => setValue(key, typeof v === 'number' ? v : 0)}
          disabled={disabled}
        />
      );
    case 'enum':
      return (
        <Select
          label={label}
          description={description}
          data={field.options.map((o) => ({ value: String(o), label: String(o) }))}
          value={String(values[key])}
          onChange={(v) => setValue(key, Number(v))}
          allowDeselect={false}
          disabled={disabled}
        />
      );
  }
}

export function ConfigTab({ serverId, running }: { serverId: string; running: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const can = useCan(serverId);
  const readOnly = !can('server.config');
  const config = useQuery({ queryKey: configKey(serverId), queryFn: () => api.config(serverId) });
  const [values, setValues] = useState<Values | null>(null);
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [restartPrompt, setRestartPrompt] = useState(false);
  const action = useServerAction(serverId);

  useEffect(() => {
    if (config.data && values === null) setValues(config.data.values);
  }, [config.data, values]);

  const dirty = useMemo(
    () => values !== null && config.data !== undefined && (JSON.stringify(values) !== JSON.stringify(config.data.values) || password !== undefined),
    [values, config.data, password],
  );

  const save = useMutation({
    mutationFn: () => api.saveConfig(serverId, { ...(values as Values), ...(password !== undefined ? { password } : {}) } as ConfigUpdate),
    onSuccess: (view) => {
      qc.setQueryData(configKey(serverId), view);
      setValues(view.values);
      setPassword(undefined);
      void qc.invalidateQueries({ queryKey: SERVERS_KEY });
      if (view.restartRequired) setRestartPrompt(true);
      else notifications.show({ color: 'green', message: t('config.saved') });
    },
  });

  if (config.isPending || values === null) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (config.isError) return <Alert color="red">{errorText(t, config.error)}</Alert>;

  const setValue = (key: keyof Values, value: unknown) => setValues((v) => ({ ...(v as Values), [key]: value }));

  return (
    <Stack gap="lg" maw={860}>
      <Text size="sm" c="dimmed">
        {t('config.intro')}
      </Text>
      {readOnly && <Alert color="gray">{t('config.readOnly')}</Alert>}
      {CONFIG_GROUPS.map((group) => (
        <Card key={group}>
          <Title order={4}>{t(`config.groups.${group}.title`)}</Title>
          <Text size="sm" c="dimmed" mb="md">
            {t(`config.groups.${group}.desc`)}
          </Text>
          <Stack gap="md">
            {CONFIG_FIELDS.filter((f) => f.group === group).map((field) => (
              <FieldInput
                key={field.key}
                field={field}
                values={values}
                setValue={setValue}
                password={password}
                setPassword={setPassword}
                passwordSet={config.data.passwordSet}
                disabled={readOnly}
              />
            ))}
          </Stack>
        </Card>
      ))}
      <Card>
        <Title order={4}>{t('config.fixed.title')}</Title>
        <Text size="sm" c="dimmed">
          {t('config.fixed.desc')}
        </Text>
      </Card>

      {!readOnly && (
        <Card style={{ position: 'sticky', bottom: 12, zIndex: 5 }} shadow="md">
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {dirty ? t('config.unsaved') : t('config.version', { version: config.data.version })}
            </Text>
            <Group gap="xs">
              {save.isError && (
                <Text size="sm" c="red">
                  {errorText(t, save.error)}
                </Text>
              )}
              <Button
                variant="default"
                disabled={!dirty || save.isPending}
                onClick={() => {
                  setValues(config.data.values);
                  setPassword(undefined);
                }}
              >
                {t('config.reset')}
              </Button>
              <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
                {t('config.save')}
              </Button>
            </Group>
          </Group>
        </Card>
      )}

      <Modal opened={restartPrompt} onClose={() => setRestartPrompt(false)} title={t('config.savedTitle')} centered>
        <Stack>
          <Text size="sm">{t('config.restartRequired')}</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRestartPrompt(false)}>
              {t('config.later')}
            </Button>
            <Button
              disabled={!running}
              onClick={() => {
                action.mutate('restart');
                setRestartPrompt(false);
              }}
            >
              {t('config.restartNow')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
