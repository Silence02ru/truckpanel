import { Alert, Button, Loader, PasswordInput, Text } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PASSWORD_MIN } from '@truckpanel/shared';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { api } from '../api';
import { AuthCard } from '../components/AuthCard';
import { errorText } from '../errors';
import { ME_KEY } from '../queryKeys';

/** One-time link from the administrator: set a password and sign in (docs/PHASE-7.md §7.2). */
export function InvitePage() {
  const { t } = useTranslation();
  const { token = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const info = useQuery({ queryKey: ['invite', token], queryFn: () => api.inviteInfo(token), retry: false });
  const accept = useMutation({
    mutationFn: () => api.acceptInvite(token, password),
    onSuccess: (user) => {
      qc.setQueryData(ME_KEY, user);
      void navigate('/dashboard', { replace: true });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password.length >= PASSWORD_MIN && password === repeat) accept.mutate();
  };

  if (info.isPending) {
    return (
      <AuthCard subtitle={t('invite.title')}>
        <Loader />
      </AuthCard>
    );
  }
  if (info.isError) {
    return (
      <AuthCard subtitle={t('invite.title')}>
        <Alert color="red">{errorText(t, info.error)}</Alert>
      </AuthCard>
    );
  }
  return (
    <AuthCard subtitle={t('invite.title')}>
      <form onSubmit={submit}>
        <Text size="sm" mb="md">
          {t('invite.intro', { username: info.data.username })}
        </Text>
        {accept.isError && (
          <Alert color="red" mb="md">
            {errorText(t, accept.error)}
          </Alert>
        )}
        <PasswordInput
          label={t('profile.password.new')}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          error={password && password.length < PASSWORD_MIN ? t('profile.password.tooShort', { min: PASSWORD_MIN }) : undefined}
          mb="sm"
        />
        <PasswordInput
          label={t('profile.password.repeat')}
          autoComplete="new-password"
          value={repeat}
          onChange={(e) => setRepeat(e.currentTarget.value)}
          error={repeat && repeat !== password ? t('profile.password.mismatch') : undefined}
          mb="lg"
        />
        <Button type="submit" fullWidth loading={accept.isPending} disabled={password.length < PASSWORD_MIN || password !== repeat}>
          {t('invite.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}
