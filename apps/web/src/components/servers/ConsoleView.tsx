import { ActionIcon, Group, Switch, Text, Tooltip } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { Check, Copy, Download, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { liveStore, useLive } from '../../live/store';

/**
 * Live, read-only console (the SCS DS accepts no console commands — moderators act in game).
 * Lines come over WebSocket; timestamps are arrival times on the panel (the DS prints none).
 */
export function ConsoleView({ serverId, serverName, height = 420 }: { serverId: string; serverName: string; height?: number | string }) {
  const { t } = useTranslation();
  const lines = useLive((s) => s.console[serverId]) ?? [];
  const [showTime, setShowTime] = useState(false);
  const clipboard = useClipboard({ timeout: 1500 });
  const boxRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = boxRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const text = () => lines.map((l) => (showTime ? `[${new Date(l.ts).toLocaleTimeString()}] ${l.text}` : l.text)).join('\n');

  const download = () => {
    const blob = new Blob([text() + '\n'], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${serverName.replace(/[^\w.-]+/g, '_')}-console.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div>
      <Group justify="flex-end" gap="sm" mb={6}>
        <Switch size="xs" label={t('console.time')} checked={showTime} onChange={(e) => setShowTime(e.currentTarget.checked)} />
        <Tooltip label={clipboard.copied ? t('session.copied') : t('console.copy')}>
          <ActionIcon variant="subtle" color="gray" onClick={() => clipboard.copy(text())} aria-label={t('console.copy')}>
            {clipboard.copied ? <Check size={16} /> : <Copy size={16} />}
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t('console.download')}>
          <ActionIcon variant="subtle" color="gray" onClick={download} aria-label={t('console.download')}>
            <Download size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t('console.clear')}>
          <ActionIcon variant="subtle" color="gray" onClick={() => liveStore.clearConsole(serverId)} aria-label={t('console.clear')}>
            <Trash2 size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <div
        ref={boxRef}
        className="tp-log"
        style={{ height, maxHeight: 'none' }}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {lines.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('console.waiting')}
          </Text>
        ) : (
          lines.map((l, i) => (
            <div key={i}>
              {showTime && <span style={{ opacity: 0.55 }}>[{new Date(l.ts).toLocaleTimeString()}] </span>}
              {l.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
