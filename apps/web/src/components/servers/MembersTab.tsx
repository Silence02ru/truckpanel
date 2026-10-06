import { ActionIcon, Alert, Badge, Button, Card, Group, Modal, Select, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ASSIGNABLE_SERVER_ROLES, type Member, type ServerSummary } from '@truckpanel/shared';
import { Crown, LogOut, Trash2, UserPlus, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api } from '../../api';
import { errorText } from '../../errors';
import { useMe } from '../../hooks/useMe';
import { SERVERS_KEY, membersKey, serverKey } from '../../queryKeys';

/** Who may manage this server (docs/PHASE-7.md §7.2). */
export function MembersTab({ server }: { server: Pick<ServerSummary, 'id' | 'name' | 'access'> }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const navigate = useNavigate();
  const manage = server.access.permissions.includes('server.members');
  const members = useQuery({ queryKey: membersKey(server.id), queryFn: () => api.members(server.id) });
  const [login, setLogin] = useState('');
  const [role, setRole] = useState<string>('moderator');
  const [transferTo, setTransferTo] = useState<Member | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: membersKey(server.id) });
    void qc.invalidateQueries({ queryKey: serverKey(server.id) });
    void qc.invalidateQueries({ queryKey: SERVERS_KEY });
  };
  const onError = (e: unknown) => notifications.show({ color: 'red', message: errorText(t, e) });
  const add = useMutation({
    mutationFn: () => api.addMember(server.id, login.trim(), role),
    onSuccess: () => {
      setLogin('');
      refresh();
    },
  });
  const update = useMutation({ mutationFn: (v: { userId: string; role: string }) => api.updateMember(server.id, v.userId, v.role), onSuccess: refresh, onError });
  const remove = useMutation({
    mutationFn: (userId: string) => api.removeMember(server.id, userId),
    onSuccess: (_r, userId) => {
      if (userId === me?.id) {
        void qc.invalidateQueries({ queryKey: SERVERS_KEY });
        void navigate('/dashboard');
      } else refresh();
    },
    onError,
  });
  const transfer = useMutation({
    mutationFn: (userId: string) => api.transferServer(server.id, userId),
    onSuccess: () => {
      setTransferTo(null);
      refresh();
      notifications.show({ color: 'green', message: t('members.transferred') });
    },
  });

  const roleOptions = ASSIGNABLE_SERVER_ROLES.map((r) => ({ value: r, label: t(`members.role.${r}`) }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (login.trim()) add.mutate();
  };
  const myMembership = members.data?.find((m) => m.userId === me?.id);

  return (
    <Stack gap="lg">
      <Card>
        <Group gap="xs" mb={4}>
          <Users size={18} />
          <Title order={4}>{t('members.title')}</Title>
        </Group>
        <Text size="sm" c="dimmed" mb="md">
          {t('members.intro')}
        </Text>
        {manage && (
          <form onSubmit={submit}>
            <Group align="flex-start" mb="md">
              <TextInput
                style={{ flex: 1 }}
                placeholder={t('members.loginPlaceholder')}
                value={login}
                onChange={(e) => setLogin(e.currentTarget.value)}
                error={add.isError ? errorText(t, add.error) : undefined}
              />
              <Select data={roleOptions} value={role} onChange={(v) => v && setRole(v)} allowDeselect={false} w={170} />
              <Button type="submit" leftSection={<UserPlus size={16} />} loading={add.isPending} disabled={!login.trim()}>
                {t('members.add')}
              </Button>
            </Group>
          </form>
        )}
        {members.isError && <Alert color="red">{errorText(t, members.error)}</Alert>}
        <Table className="tp-table" verticalSpacing="sm">
          <Table.Tbody>
            {(members.data ?? []).map((m) => (
              <Table.Tr key={m.userId}>
                <Table.Td>
                  <Group gap="xs">
                    <Text fw={600} size="sm">
                      {m.username}
                    </Text>
                    {m.userId === me?.id && (
                      <Badge size="xs" variant="light">
                        {t('members.you')}
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td w={200}>
                  {m.role === 'owner' ? (
                    <Badge color="amber" variant="light" leftSection={<Crown size={12} />}>
                      {t('members.role.owner')}
                    </Badge>
                  ) : manage ? (
                    <Select
                      size="xs"
                      data={roleOptions}
                      value={m.role}
                      allowDeselect={false}
                      onChange={(v) => v && v !== m.role && update.mutate({ userId: m.userId, role: v })}
                    />
                  ) : (
                    <Badge variant="light" color="gray">
                      {t(`members.role.${m.role}`)}
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td w={120}>
                  <Group gap={4} justify="flex-end" wrap="nowrap">
                    {manage && m.role !== 'owner' && (
                      <Tooltip label={t('members.makeOwner')}>
                        <ActionIcon variant="subtle" color="amber" onClick={() => setTransferTo(m)} aria-label={t('members.makeOwner')}>
                          <Crown size={16} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                    {manage && m.role !== 'owner' && m.userId !== me?.id && (
                      <Tooltip label={t('members.remove')}>
                        <ActionIcon variant="subtle" color="red" onClick={() => remove.mutate(m.userId)} aria-label={t('members.remove')}>
                          <Trash2 size={16} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {myMembership && myMembership.role !== 'owner' && (
          <Group justify="flex-end" mt="md">
            <Button variant="subtle" color="red" leftSection={<LogOut size={16} />} onClick={() => remove.mutate(myMembership.userId)}>
              {t('members.leave')}
            </Button>
          </Group>
        )}
      </Card>

      <Modal opened={transferTo !== null} onClose={() => setTransferTo(null)} title={t('members.transferTitle')}>
        <Text size="sm" mb="md">
          {t('members.transferText', { username: transferTo?.username ?? '', server: server.name })}
        </Text>
        {transfer.isError && (
          <Alert color="red" mb="md">
            {errorText(t, transfer.error)}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setTransferTo(null)}>
            {t('common.cancel')}
          </Button>
          <Button color="amber" loading={transfer.isPending} onClick={() => transferTo && transfer.mutate(transferTo.userId)}>
            {t('members.makeOwner')}
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}
