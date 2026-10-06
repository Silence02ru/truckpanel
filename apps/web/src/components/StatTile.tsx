import { Group, Stack, Text } from '@mantine/core';
import type { LucideIcon } from 'lucide-react';

/** One cell of the `.tp-stat-tiles` strip. */
export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
}) {
  return (
    <Stack gap={2} p="md">
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" c="dimmed">
          {label}
        </Text>
        <Icon size={18} strokeWidth={1.75} color="var(--mantine-color-dimmed)" />
      </Group>
      <Text fz={26} fw={650} lh={1.2}>
        {value}
      </Text>
      {hint && (
        <Text size="sm" c="dimmed">
          {hint}
        </Text>
      )}
    </Stack>
  );
}
