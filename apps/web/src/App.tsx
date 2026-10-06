import { Center, Loader } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router';
import { api } from './api';
import { meQueryOptions } from './hooks/useMe';
import { LiveShell } from './components/Shell';
import { DashboardPage } from './pages/DashboardPage';
import { ProfilePage } from './pages/ProfilePage';
import { UsersPage } from './pages/UsersPage';
import { AuditPage } from './pages/AuditPage';
import { InvitePage } from './pages/InvitePage';
import { LoginPage } from './pages/LoginPage';
import { ServerPage } from './pages/ServerPage';
import { SetupPage } from './pages/SetupPage';
import { SETUP_KEY } from './queryKeys';

export function App() {
  // setup/status also issues the CSRF cookie, so it must resolve before any POST.
  const setup = useQuery({ queryKey: SETUP_KEY, queryFn: api.setupStatus });
  const me = useQuery({ ...meQueryOptions, enabled: setup.isSuccess });

  if (setup.isPending || (setup.isSuccess && me.isPending)) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  const setupRequired = setup.data?.required ?? false;
  const user = me.data ?? null;

  return (
    <Routes>
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route path="/setup" element={setupRequired ? <SetupPage /> : <Navigate to="/" replace />} />
      <Route
        path="/login"
        element={setupRequired ? <Navigate to="/setup" replace /> : user ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        element={
          setupRequired ? <Navigate to="/setup" replace /> : user ? <LiveShell user={user} /> : <Navigate to="/login" replace />
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/servers/:id" element={<ServerPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}
