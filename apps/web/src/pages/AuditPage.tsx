import { Alert, Button, Card, Code, Group, Select, Stack, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { AuditEntry } from '@truckpanel/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { PageHeader } from '../components/PageHeader';
import { errorText } from '../errors';
import { useMe } from '../hooks/useMe';
import { useServers } from '../hooks/useServers';
import { AUDIT_KEY } from '../queryKeys';

const PAGE = 50;

function details(e: AuditEntry): string {
  const parts: string[] = [];
  if (e.oldValue !== null && e.oldValue !== undefined) parts.push(`− ${JSON.stringify(e.oldValue)}`);
  if (e.newValue !== null && e.newValue !== undefined) parts.push(`+ ${JSON.stringify(e.newValue)}`);
  return parts.join('\n');
}

/** Audit log: administrators see everything, users the servers they own (docs/PHASE-7.md §7.2). */
export function AuditPage() {
  const { t } = useTranslation();
  const me = useMe();
  const servers = useServers();
  const [action, setAction] = useState('');
  const [serverId, setServerId] = useState<string | null>(null);
  const names = new Map((servers.data ?? []).map((s) => [s.id, s.name]));

  const q = useInfiniteQuery({
    queryKey: [...AUDIT_KEY, action, serverId],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api.audit({
        limit: String(PAGE),
        ...(action.trim() ? { action: action.trim() } : {}),
        ...(serverId ? { serverId } : {}),
        ...(pageParam ? { before: pageParam } : {}),
      }),
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1]!.ts : undefined),
  });
  const rows = q.data?.pages.flat() ?? [];

  const target = (e: AuditEntry) => {
    if (!e.target) return '—';
    const [kind, id] = e.target.split(':');
    if (kind === 'server' && id) return names.get(id) ?? t('audit.deletedServer');
    return e.target;
  };

  return (
    <Stack gap="xl">
      <PageHeader
        eyebrow={t('audit.eyebrow')}
        title={t('audit.title')}
        subtitle={me?.role === 'administrator' ? t('audit.subtitleAdmin') : t('audit.subtitleUser')}
      />
      <Group align="flex-end">
        <TextInput label={t('audit.action')} placeholder="server., user., auth." value={action} onChange={(e) => setAction(e.currentTarget.value)} />
        <Select
          label={t('audit.server')}
          clearable
          placeholder={t('audit.allServers')}
          data={(servers.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
          value={serverId}
          onChange={setServerId}
        />
      </Group>
      {q.isError && <Alert color="red">{errorText(t, q.error)}</Alert>}
      <Card p={0}>
        <Table.ScrollContainer minWidth={900}>
          <Table className="tp-table" verticalSpacing="sm" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('audit.when')}</Table.Th>
                <Table.Th>{t('audit.who')}</Table.Th>
                <Table.Th>{t('audit.action')}</Table.Th>
                <Table.Th>{t('audit.target')}</Table.Th>
                <Table.Th>{t('audit.details')}</Table.Th>
                <Table.Th>IP</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((e) => (
                <Table.Tr key={e.id}>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {new Date(e.ts).toLocaleString()}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{e.user?.username ?? '—'}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Code>{e.action}</Code>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{target(e)}</Text>
                  </Table.Td>
                  <Table.Td maw={360}>
                    {details(e) && (
                      <Tooltip label={<pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{details(e)}</pre>} multiline w={420}>
                        <Text size="xs" c="dimmed" lineClamp={2} className="tp-mono">
                          {details(e)}
                        </Text>
                      </Tooltip>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" className="tp-mono">
                      {e.ip ?? '—'}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
              {rows.length === 0 && !q.isPending && (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <Text c="dimmed" ta="center" py="lg">
                      {t('audit.empty')}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
      {q.hasNextPage && (
        <Group justify="center">
          <Button variant="default" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {t('audit.more')}
          </Button>
        </Group>
      )}
    </Stack>
  );
}
