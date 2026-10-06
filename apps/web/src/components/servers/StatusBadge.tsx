import { Badge } from '@mantine/core';
import type { ServerState } from '@truckpanel/shared';
import { useTranslation } from 'react-i18next';

const COLOR: Record<ServerState, string> = {
  NEW: 'gray',
  INSTALLING: 'blue',
  AWAITING_PACKAGES: 'yellow',
  STOPPED: 'gray',
  STARTING: 'blue',
  ONLINE: 'green',
  STOPPING: 'blue',
  UPDATING: 'blue',
  ERROR: 'red',
  UNKNOWN: 'gray',
};

export function StatusBadge({ state, size = 'md' }: { state: ServerState; size?: 'sm' | 'md' | 'lg' }) {
  const { t } = useTranslation();
  return (
    <Badge color={COLOR[state]} variant="light" size={size} radius="xl" leftSection={<span className="tp-dot" />} style={{ overflow: "visible", flexShrink: 0 }} styles={{ label: { overflow: "visible" } }}>
      {t(`serverState.${state}`)}
    </Badge>
  );
}
