import { Group, Progress, Stack, Text } from '@mantine/core';
import type { ServerMetrics } from '@truckpanel/shared';
import { formatBytes, percent } from '../../live/format';

/** OVH-style compact CPU/RAM bars for the server table. */
export function MetricBars({ metrics }: { metrics: ServerMetrics | undefined }) {
  if (!metrics) {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  const mem = percent(metrics.memUsedBytes, metrics.memLimitBytes);
  return (
    <Stack gap={6} w={170}>
      <Row label="CPU" value={Math.min(100, metrics.cpuPercent)} text={`${metrics.cpuPercent.toFixed(1)}%`} />
      <Row label="RAM" value={mem} text={formatBytes(metrics.memUsedBytes)} />
    </Stack>
  );
}

function Row({ label, value, text }: { label: string; value: number; text: string }) {
  return (
    <Group gap={8} wrap="nowrap">
      <Text size="xs" c="dimmed" w={28}>
        {label}
      </Text>
      <Progress value={value} size="sm" style={{ flex: 1 }} color={value > 85 ? 'red' : value > 60 ? 'yellow' : 'blue'} />
      <Text size="xs" className="tp-mono" w={56} ta="right">
        {text}
      </Text>
    </Group>
  );
}
