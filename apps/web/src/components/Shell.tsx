import {
  ActionIcon,
  AppShell,
  Avatar,
  Burger,
  Group,
  Menu,
  NavLink,
  ScrollArea,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { APP_VERSION, can, type CurrentUser, type Permission, type ServerState } from '@truckpanel/shared';
import { LayoutDashboard, LogOut, PanelLeftClose, PanelLeftOpen, ScrollText, UserRound, Users, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink as RouterNavLink, Outlet, useLocation } from 'react-router';
import { api } from '../api';
import { useServers } from '../hooks/useServers';
import { useApplyProfilePreferences } from '../hooks/useMe';
import { LiveProvider, useLiveSubscription } from '../live/LiveProvider';
import { ConsoleDock } from './ConsoleDock';
import { ME_KEY } from '../queryKeys';
import { LanguageSwitch } from './LanguageSwitch';
import { Logo } from './Logo';
import { ThemeToggle } from './ThemeToggle';

interface NavItem {
  to: string;
  labelKey: string;
  icon: LucideIcon;
  /** Global permission; no permission = every signed-in user. */
  permission?: Permission;
}

// Only pages that exist are listed; sections appear as later phases add them.
const SERVER_NAV: NavItem[] = [
  { to: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard },
];
const ADMIN_NAV: NavItem[] = [
  { to: '/users', labelKey: 'nav.users', icon: Users, permission: 'users.manage' },
  { to: '/audit', labelKey: 'nav.audit', icon: ScrollText, permission: 'audit.view' },
];

const TITLES: Record<string, string> = { '/dashboard': 'nav.dashboard', '/profile': 'profile.title', '/users': 'nav.users', '/audit': 'nav.audit' };

const STATE_DOT: Record<ServerState, string> = {
  NEW: 'var(--mantine-color-gray-6)',
  INSTALLING: 'var(--mantine-color-blue-5)',
  AWAITING_PACKAGES: 'var(--mantine-color-yellow-5)',
  STOPPED: 'var(--mantine-color-gray-6)',
  STARTING: 'var(--mantine-color-blue-5)',
  ONLINE: 'var(--mantine-color-green-5)',
  STOPPING: 'var(--mantine-color-blue-5)',
  UPDATING: 'var(--mantine-color-blue-5)',
  ERROR: 'var(--mantine-color-red-5)',
  UNKNOWN: 'var(--mantine-color-gray-6)',
};

export function Shell({ user }: { user: CurrentUser }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [mobileOpen, { toggle: toggleMobile, close: closeMobile }] = useDisclosure(false);
  const [desktopCollapsed, { toggle: toggleDesktop }] = useDisclosure(false);
  useApplyProfilePreferences(user);

  const signOut = async (everywhere: boolean) => {
    try {
      await (everywhere ? api.logoutAll() : api.logout());
    } finally {
      queryClient.setQueryData(ME_KEY, null);
    }
  };

  const renderItems = (items: NavItem[]) =>
    items
      .filter((item) => !item.permission || user.permissions.includes(item.permission))
      .map((item) => (
        <NavLink
          key={item.to}
          component={RouterNavLink}
          to={item.to}
          className="tp-nav-link"
          label={t(item.labelKey)}
          leftSection={<item.icon size={18} strokeWidth={1.75} />}
          active={location.pathname.startsWith(item.to)}
          onClick={closeMobile}
        />
      ));

  const adminItems = renderItems(ADMIN_NAV);
  const servers = useServers();
  const instances = servers.data ?? [];
  const titleKey = TITLES[location.pathname];

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 260, breakpoint: 'sm', collapsed: { mobile: !mobileOpen, desktop: desktopCollapsed } }}
      padding={{ base: 'md', md: 'xl' }}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={mobileOpen} onClick={toggleMobile} hiddenFrom="sm" size="sm" />
            {desktopCollapsed && (
              <Tooltip label={t('shell.expandSidebar')}>
                <ActionIcon variant="subtle" color="gray" visibleFrom="sm" onClick={toggleDesktop} aria-label={t('shell.expandSidebar')}>
                  <PanelLeftOpen size={18} />
                </ActionIcon>
              </Tooltip>
            )}
            <Text fw={600}>{titleKey ? t(titleKey) : location.pathname.startsWith('/servers/') ? t('servers.title') : t('app.name')}</Text>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <LanguageSwitch />
            <ThemeToggle />
            <Menu position="bottom-end" width={240}>
              <Menu.Target>
                <UnstyledButton aria-label={user.username}>
                  <Avatar color="amber" radius="xl" size={34}>
                    {user.username.slice(0, 1).toUpperCase()}
                  </Avatar>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>
                  <Text size="sm" fw={600} c="var(--mantine-color-text)">
                    {user.username}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {t(`shell.role.${user.role}`)}
                  </Text>
                </Menu.Label>
                <Menu.Divider />
                <Menu.Item component={Link} to="/profile" leftSection={<UserRound size={16} />}>
                  {t('shell.profile')}
                </Menu.Item>
                <Menu.Item leftSection={<LogOut size={16} />} onClick={() => void signOut(false)}>
                  {t('shell.logout')}
                </Menu.Item>
                <Menu.Item color="red" leftSection={<LogOut size={16} />} onClick={() => void signOut(true)}>
                  {t('shell.logoutAll')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar style={{ background: 'var(--tp-sidebar-bg)' }}>
        <AppShell.Section p="md" style={{ borderBottom: '1px solid var(--app-shell-border-color)' }}>
          <Logo />
        </AppShell.Section>

        <AppShell.Section grow component={ScrollArea} px="sm" pb="md">
          <div className="tp-section-label">{t('nav.servers')}</div>
          {renderItems(SERVER_NAV)}

          <div className="tp-section-label">{t('nav.instances')}</div>
          {instances.length === 0 && (
            <Text size="sm" c="dimmed" px="sm">
              {t('nav.noInstances')}
            </Text>
          )}
          {instances.map((s) => (
            <NavLink
              key={s.id}
              component={RouterNavLink}
              to={`/servers/${s.id}`}
              className="tp-nav-link"
              label={s.name}
              leftSection={<span className="tp-dot" style={{ color: STATE_DOT[s.state] }} />}
              rightSection={
                s.players !== null ? (
                  <Text size="xs" c="dimmed">
                    {s.players}
                  </Text>
                ) : null
              }
              active={location.pathname === `/servers/${s.id}`}
              onClick={closeMobile}
            />
          ))}

          {adminItems.length > 0 && (
            <>
              <div className="tp-section-label">{t('nav.administration')}</div>
              {adminItems}
            </>
          )}
        </AppShell.Section>

        <AppShell.Section p="md" style={{ borderTop: '1px solid var(--app-shell-border-color)' }}>
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              v{APP_VERSION}
              <Text span size="xs" c="dimmed" ml={6}>
                {t('shell.build', { date: new Date(__BUILD_TIME__).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) })}
              </Text>
            </Text>
            <Tooltip label={t('shell.collapseSidebar')}>
              <ActionIcon variant="subtle" color="gray" visibleFrom="sm" onClick={toggleDesktop} aria-label={t('shell.collapseSidebar')}>
                <PanelLeftClose size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <GlobalSubscriptions />
        <Outlet />
        <ConsoleDock />
      </AppShell.Main>
    </AppShell>
  );
}

/** Status, tasks and metrics of every server, for the table, sidebar and dock. */
function GlobalSubscriptions() {
  useLiveSubscription('*', ['status', 'tasks', 'metrics']);
  return null;
}

/** The WebSocket lives as long as the signed-in layout. */
export function LiveShell({ user }: { user: CurrentUser }) {
  return (
    <LiveProvider>
      <Shell user={user} />
    </LiveProvider>
  );
}
