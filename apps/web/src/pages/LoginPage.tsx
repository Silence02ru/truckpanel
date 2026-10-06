import { Alert, Button, PasswordInput, TextInput } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { ME_KEY } from '../queryKeys';
import { AuthCard } from '../components/AuthCard';
import { errorText } from '../errors';

export function LoginPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');

  const mutation = useMutation({
    mutationFn: api.login,
    onSuccess: (user) => queryClient.setQueryData(ME_KEY, user),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate({ login, password });
  };

  return (
    <AuthCard subtitle={t('login.subtitle')}>
      <form onSubmit={submit}>
        {mutation.isError && (
          <Alert color="red" mb="md">
            {errorText(t, mutation.error)}
          </Alert>
        )}
        <TextInput
          label={t('login.login')}
          autoComplete="username"
          required
          value={login}
          onChange={(e) => setLogin(e.currentTarget.value)}
          mb="sm"
        />
        <PasswordInput
          label={t('login.password')}
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          mb="lg"
        />
        <Button type="submit" fullWidth loading={mutation.isPending}>
          {t('login.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}
