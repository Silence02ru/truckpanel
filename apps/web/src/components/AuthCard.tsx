import { Box, Center, Group, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { LanguageSwitch } from './LanguageSwitch';
import { Logo } from './Logo';
import { ThemeToggle } from './ThemeToggle';

/** Borderless centered form on the page background (valheim-server-ui style). */
export function AuthCard({ subtitle, children }: { subtitle: string; children: ReactNode }) {
  return (
    <Box mih="100vh" pos="relative">
      <Group pos="absolute" top={16} right={16} gap="xs">
        <LanguageSwitch />
        <ThemeToggle />
      </Group>
      <Center mih="100vh" p="md">
        <Stack w="100%" maw={400} gap="lg">
          <Logo size="lg" />
          <Text c="dimmed">{subtitle}</Text>
          {children}
        </Stack>
      </Center>
    </Box>
  );
}
