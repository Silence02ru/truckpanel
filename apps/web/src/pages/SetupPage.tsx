import { Alert, Button, PasswordInput, TextInput, Title } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PASSWORD_MIN, USERNAME_RE } from '@truckpanel/shared';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { api } from '../api';
import { ME_KEY, SETUP_KEY } from '../queryKeys';
import { AuthCard } from '../components/AuthCard';
import { errorText } from '../errors';

export function SetupPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ token: params.get('token') ?? '', username: '', email: '', password: '' });
  const set = (key: keyof typeof form) => (e: { currentTarget: { value: string } }) => {
    // Read now: currentTarget is null by the time the state updater runs.
    const value = e.currentTarget.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  const mutation = useMutation({
    mutationFn: api.setupAdmin,
    onSuccess: (user) => {
      queryClient.setQueryData(ME_KEY, user);
      queryClient.setQueryData(SETUP_KEY, { required: false });
    },
  });

  const usernameInvalid = form.username !== '' && !USERNAME_RE.test(form.username);
  const passwordInvalid = form.password !== '' && form.password.length < PASSWORD_MIN;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (usernameInvalid || passwordInvalid) return;
    mutation.mutate(form);
  };

  return (
    <AuthCard subtitle={t('setup.intro')}>
      <Title order={3}>{t('setup.title')}</Title>
      <form onSubmit={submit}>
        {mutation.isError && (
          <Alert color="red" mb="md">
            {errorText(t, mutation.error)}
          </Alert>
        )}
        <PasswordInput label={t('setup.token')} required value={form.token} onChange={set('token')} mb="sm" />
        <TextInput
          label={t('setup.username')}
          description={t('setup.usernameHint')}
          autoComplete="username"
          required
          value={form.username}
          onChange={set('username')}
          error={usernameInvalid}
          mb="sm"
        />
        <TextInput
          label={t('setup.email')}
          type="email"
          autoComplete="email"
          required
          value={form.email}
          onChange={set('email')}
          mb="sm"
        />
        <PasswordInput
          label={t('setup.password')}
          description={t('setup.passwordHint')}
          autoComplete="new-password"
          required
          value={form.password}
          onChange={set('password')}
          error={passwordInvalid}
          mb="lg"
        />
        <Button type="submit" fullWidth loading={mutation.isPending}>
          {t('setup.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}
