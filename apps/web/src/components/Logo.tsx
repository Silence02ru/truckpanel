import { Group, Text } from '@mantine/core';
import { Truck } from 'lucide-react';

export function Logo({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 40 : 30;
  return (
    <Group gap="sm" wrap="nowrap">
      <span className="tp-logo-mark" style={{ width: box, height: box }}>
        <Truck size={box * 0.6} strokeWidth={2.2} />
      </span>
      <Text fw={650} fz={size === 'lg' ? 26 : 'lg'}>
        TruckPanel
      </Text>
    </Group>
  );
}
