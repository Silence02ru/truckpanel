import { Alert, Badge, Group, Modal, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { Task } from '@truckpanel/shared';
import type { TFunction } from 'i18next';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { errorText } from '../../errors';

/** Human text for a failed task: translated by code, raw message as details. */
export function taskErrorText(t: TFunction, task: Pick<Task, 'code' | 'message'>): string | null {
  if (!task.code) return task.message;
  return t(`errors.${task.code}`, { defaultValue: task.message ?? t('errors.internal') });
}

/** Full output of a task (SteamCMD, start/stop steps). Refreshes while the task runs. */
export function TaskLogModal({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['tasks', taskId, 'log'],
    queryFn: () => api.task(taskId!),
    enabled: Boolean(taskId),
    refetchInterval: (query) => (query.state.data && ['queued', 'running'].includes(query.state.data.state) ? 2000 : false),
  });
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [q.data?.log]);

  const task = q.data;
  const error = task?.state === 'failed' ? taskErrorText(t, task) : null;

  return (
    <Modal opened={Boolean(taskId)} onClose={onClose} size="xl" title={task ? `${t(`taskKind.${task.kind}`)} · ${new Date(task.createdAt).toLocaleString()}` : t('tasks.log')}>
      <Stack gap="sm">
        {q.isError && <Alert color="red">{errorText(t, q.error)}</Alert>}
        {task && (
          <Group gap="xs">
            <Badge variant="light" color={task.state === 'succeeded' ? 'green' : task.state === 'failed' ? 'red' : 'blue'}>
              {t(`taskState.${task.state}`)}
            </Badge>
            {task.stage && (
              <Text size="sm" c="dimmed">
                {task.stage} · {task.progress}%
              </Text>
            )}
          </Group>
        )}
        {error && (
          <Alert color="red" title={t('tasks.whyFailed')}>
            <Text size="sm">{error}</Text>
            {task?.code && task.message && task.message !== error && (
              <Text size="xs" c="dimmed" mt={6} className="tp-mono" style={{ whiteSpace: 'pre-wrap' }}>
                {task.message}
              </Text>
            )}
          </Alert>
        )}
        <div className="tp-log" style={{ height: 420, maxHeight: 'none', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {task?.log || t('tasks.noLog')}
          <div ref={bottom} />
        </div>
        <Text size="xs" c="dimmed">
          {t('tasks.logHint')}
        </Text>
      </Stack>
    </Modal>
  );
}
