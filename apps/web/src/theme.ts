import { createTheme, type MantineColorsTuple } from '@mantine/core';

// Amber accent (hybrid of valheim-server-ui look and OVH game-panel layout).
const amber: MantineColorsTuple = [
  '#fff8e1',
  '#ffefc2',
  '#ffdf85',
  '#ffcd47',
  '#fdbd1a',
  '#f5a50b',
  '#e09000',
  '#c27a00',
  '#9c6200',
  '#7a4c00',
];

// Near-black neutrals for the dark scheme: [7] body, [6] cards/inputs, [4] borders, [0] text.
const dark: MantineColorsTuple = [
  '#e7e7ea',
  '#c6c6cc',
  '#9b9ba3',
  '#75757e',
  '#2c2c32',
  '#222227',
  '#17171a',
  '#0e0e10',
  '#0a0a0c',
  '#060607',
];

export const theme = createTheme({
  primaryColor: 'amber',
  primaryShade: { light: 6, dark: 5 },
  autoContrast: true,
  colors: { amber, dark },
  fontFamily: "'Inter Variable', system-ui, sans-serif",
  fontFamilyMonospace: "'Source Code Pro', ui-monospace, monospace",
  headings: { fontFamily: "'Inter Variable', system-ui, sans-serif", fontWeight: '650' },
  defaultRadius: 'md',
  cursorType: 'pointer',
  components: {
    Card: { defaultProps: { withBorder: true, radius: 'md' } },
    Paper: { defaultProps: { radius: 'md' } },
  },
});
