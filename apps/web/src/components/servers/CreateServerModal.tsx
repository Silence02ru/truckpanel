import { Alert, Button, Modal, SegmentedControl, Stack, Text, TextInput } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GAMES, SERVER_NAME_MAX, type GameId } from '@truckpanel/shared';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api } from '../../api';
import { errorText } from '../../errors';
import { SERVERS_KEY } from '../../queryKeys';

export function CreateServerModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [game, setGame] = useState<GameId>('ets2');

  const mutation = useMutation({
    mutationFn: api.createServer,
    onSuccess: ({ server }) => {
      void qc.invalidateQueries({ queryKey: SERVERS_KEY });
      onClose();
      setName('');
      navigate(`/servers/${server.id}`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate({ name: name.trim(), game });
  };

  return (
    <Modal opened={opened} onClose={onClose} title={t('servers.createTitle')} centered>
      <form onSubmit={submit}>
        <Stack>
          {mutation.isError && <Alert color="red">{errorText(t, mutation.error)}</Alert>}
          <SegmentedControl
            fullWidth
            value={game}
            onChange={(v) => setGame(v as GameId)}
            data={(Object.keys(GAMES) as GameId[]).map((g) => ({ value: g, label: GAMES[g].label }))}
          />
          <TextInput
            label={t('servers.name')}
            description={t('servers.nameHint')}
            required
            maxLength={SERVER_NAME_MAX}
            value={name}
            onChange={(e) => {
              const value = e.currentTarget.value;
              setName(value);
            }}
            data-autofocus
          />
          <Text size="sm" c="dimmed">
            {t('servers.createInfo')}
          </Text>
          <Button type="submit" loading={mutation.isPending} disabled={!name.trim()}>
            {t('servers.create')}
          </Button>
        </Stack>
      </form>
    </Modal>
  );
}
