import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  CopyButton,
  Group,
  Menu,
  Modal,
  NumberInput,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ZERO_QUOTA, type Invite, type Quota, type Role, type UserAdminView } from '@truckpanel/shared';
import { Check, Copy, KeyRound, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { PageHeader } from '../components/PageHeader';
import { errorText } from '../errors';
import { useMe } from '../hooks/useMe';
import { USERS_KEY } from '../queryKeys';

/** Accounts, roles and quotas — administrators only (docs/PHASE-7.md §7.2). */
export function UsersPage() {
  const { t } = useTranslation();
  const me = useMe();
  const users = useQuery({ queryKey: USERS_KEY, queryFn: api.users });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserAdminView | null>(null);
  const [invite, setInvite] = useState<{ username: string; invite: Invite } | null>(null);
  const [deleting, setDeleting] = useState<UserAdminView | null>(null);
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: USERS_KEY });

  const reset = useMutation({
    mutationFn: (u: UserAdminView) => api.inviteUser(u.id).then((inv) => ({ username: u.username, invite: inv })),
    onSuccess: (r) => setInvite(r),
    onError: (e) => notifications.show({ color: 'red', message: errorText(t, e) }),
  });
  const remove = useMutation({
    mutationFn: (u: UserAdminView) => api.deleteUser(u.id),
    onSuccess: () => {
      setDeleting(null);
      refresh();
    },
  });

  if (!me?.permissions.includes('users.manage')) return <Alert color="red">{t('errors.forbidden')}</Alert>;

  return (
    <Stack gap="xl">
      <PageHeader
        eyebrow={t('users.eyebrow')}
        title={t('users.title')}
        subtitle={t('users.subtitle')}
        actions={
          <Button leftSection={<Plus size={18} />} onClick={() => setCreating(true)}>
            {t('users.add')}
          </Button>
        }
      />
      {users.isError && <Alert color="red">{errorText(t, users.error)}</Alert>}
      <Card p={0}>
        <Table.ScrollContainer minWidth={900}>
          <Table className="tp-table" verticalSpacing="sm" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('users.user')}</Table.Th>
                <Table.Th>{t('users.role')}</Table.Th>
                <Table.Th>{t('users.servers')}</Table.Th>
                <Table.Th>RAM</Table.Th>
                <Table.Th>CPU</Table.Th>
                <Table.Th>{t('users.status')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(users.data ?? []).map((u) => {
                const admin = u.role === 'administrator';
                const of = (used: number, limit: number) => (admin ? `${used} / ∞` : `${used} / ${limit}`);
                return (
                  <Table.Tr key={u.id}>
                    <Table.Td>
                      <Text fw={600} size="sm">
                        {u.username}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {u.email}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="light" color={admin ? 'amber' : 'gray'}>
                        {t(`shell.role.${u.role}`)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{of(u.usage.servers, u.quota.servers)}</Table.Td>
                    <Table.Td>{of(u.usage.memoryMb, u.quota.memoryMb)} MB</Table.Td>
                    <Table.Td>{of(u.usage.cpus, u.quota.cpus)}</Table.Td>
                    <Table.Td>
                      {u.disabled ? (
                        <Badge color="red" variant="light">
                          {t('users.disabled')}
                        </Badge>
                      ) : u.invitePending ? (
                        <Badge color="yellow" variant="light">
                          {t('users.invitePending')}
                        </Badge>
                      ) : (
                        <Badge color="green" variant="light">
                          {t('users.active')}
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Menu position="bottom-end">
                        <Menu.Target>
                          <ActionIcon variant="subtle" color="gray" aria-label={t('users.actions')}>
                            <MoreHorizontal size={16} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Item leftSection={<Pencil size={14} />} onClick={() => setEditing(u)}>
                            {t('users.edit')}
                          </Menu.Item>
                          <Menu.Item leftSection={<KeyRound size={14} />} onClick={() => reset.mutate(u)}>
                            {u.invitePending ? t('users.newInvite') : t('users.resetPassword')}
                          </Menu.Item>
                          {u.id !== me.id && (
                            <Menu.Item color="red" leftSection={<Trash2 size={14} />} onClick={() => setDeleting(u)}>
                              {t('users.delete')}
                            </Menu.Item>
                          )}
                        </Menu.Dropdown>
                      </Menu>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>

      <UserModal
        opened={creating || editing !== null}
        user={editing}
        selfId={me.id}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onCreated={(username, inv) => {
          setCreating(false);
          setInvite({ username, invite: inv });
          refresh();
        }}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />

      <Modal opened={invite !== null} onClose={() => setInvite(null)} title={t('users.inviteTitle', { username: invite?.username ?? '' })} size="lg">
        {invite && (
          <Stack>
            <Text size="sm">{t('users.inviteText', { time: new Date(invite.invite.expiresAt).toLocaleString() })}</Text>
            <Group wrap="nowrap">
              <TextInput readOnly value={invite.invite.inviteUrl} style={{ flex: 1 }} className="tp-mono" onFocus={(e) => e.currentTarget.select()} />
              <CopyButton value={invite.invite.inviteUrl}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? t('session.copied') : t('console.copy')}>
                    <ActionIcon size="lg" variant="default" onClick={copy}>
                      {copied ? <Check size={16} /> : <Copy size={16} />}
                    </ActionIcon>
                  </Tooltip>
                )}
              </CopyButton>
            </Group>
            <Alert color="yellow" variant="light">
              {t('users.inviteWarning')}
            </Alert>
          </Stack>
        )}
      </Modal>

      <Modal opened={deleting !== null} onClose={() => setDeleting(null)} title={t('users.deleteTitle', { username: deleting?.username ?? '' })}>
        <Text size="sm" mb="md">
          {t('users.deleteText')}
        </Text>
        {remove.isError && (
          <Alert color="red" mb="md">
            {errorText(t, remove.error)}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleting(null)}>
            {t('common.cancel')}
          </Button>
          <Button color="red" loading={remove.isPending} onClick={() => deleting && remove.mutate(deleting)}>
            {t('users.delete')}
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}

function QuotaFields({ quota, onChange }: { quota: Quota; onChange: (q: Quota) => void }) {
  const { t } = useTranslation();
  return (
    <SimpleGrid cols={2}>
      <NumberInput label={t('users.quotaServers')} min={0} max={100} value={quota.servers} onChange={(v) => onChange({ ...quota, servers: Number(v) || 0 })} />
      <NumberInput label={t('users.quotaMemory')} min={0} step={1024} value={quota.memoryMb} onChange={(v) => onChange({ ...quota, memoryMb: Number(v) || 0 })} suffix=" MB" />
      <NumberInput label={t('users.quotaCpus')} min={0} step={0.5} decimalScale={1} value={quota.cpus} onChange={(v) => onChange({ ...quota, cpus: Number(v) || 0 })} />
      <NumberInput label={t('users.quotaBackups')} min={0} step={1024} value={quota.backupMb} onChange={(v) => onChange({ ...quota, backupMb: Number(v) || 0 })} suffix=" MB" />
    </SimpleGrid>
  );
}

function UserModal({
  opened,
  user,
  selfId,
  onClose,
  onCreated,
  onSaved,
}: {
  opened: boolean;
  user: UserAdminView | null;
  selfId: string;
  onClose: () => void;
  onCreated: (username: string, invite: Invite) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [quota, setQuota] = useState<Quota>({ ...ZERO_QUOTA, servers: 1, memoryMb: 4096, cpus: 2, backupMb: 2048 });
  const [disabled, setDisabled] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  if (opened && user && loadedFor !== user.id) {
    setLoadedFor(user.id);
    setRole(user.role);
    setQuota(user.quota);
    setDisabled(user.disabled);
  }
  if (opened && !user && loadedFor !== 'new') {
    setLoadedFor('new');
    setUsername('');
    setEmail('');
    setRole('user');
    setDisabled(false);
  }

  const save = useMutation({
    mutationFn: async () => {
      if (user) {
        await api.updateUser(user.id, { role, quota, disabled });
        return null;
      }
      return api.createUser({ username: username.trim(), email: email.trim(), role, quota });
    },
    onSuccess: (r) => {
      setLoadedFor(null);
      if (r) onCreated(r.user.username, r.invite);
      else onSaved();
    },
  });
  const self = user?.id === selfId;

  return (
    <Modal
      opened={opened}
      onClose={() => {
        setLoadedFor(null);
        save.reset();
        onClose();
      }}
      title={user ? t('users.editTitle', { username: user.username }) : t('users.add')}
      size="lg"
    >
      <Stack>
        {!user && (
          <>
            <TextInput label={t('profile.account.username')} value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
            <TextInput label={t('profile.account.email')} type="email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
          </>
        )}
        <div>
          <Text size="sm" fw={500} mb={4}>
            {t('users.role')}
          </Text>
          <SegmentedControl
            value={role}
            disabled={self}
            onChange={(v) => setRole(v as Role)}
            data={[
              { value: 'user', label: t('shell.role.user') },
              { value: 'administrator', label: t('shell.role.administrator') },
            ]}
          />
          <Text size="xs" c="dimmed" mt={4}>
            {t('users.roleHint')}
          </Text>
        </div>
        {role === 'user' && (
          <>
            <Text size="sm" fw={500}>
              {t('users.quota')}
            </Text>
            <QuotaFields quota={quota} onChange={setQuota} />
          </>
        )}
        {user && !self && <Switch label={t('users.disableAccount')} checked={disabled} onChange={(e) => setDisabled(e.currentTarget.checked)} />}
        {save.isError && <Alert color="red">{errorText(t, save.error)}</Alert>}
        <Group justify="flex-end">
          <Button loading={save.isPending} onClick={() => save.mutate()} disabled={!user && (!username.trim() || !email.trim())}>
            {user ? t('profile.save') : t('users.createAndInvite')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
