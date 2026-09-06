import { createHostGlobalProps, type LynxHostGlobalProps } from './host/embedding';
import { LynxShellApp } from './shell/ShellApp';

export type AppProps = {
  host?: LynxHostGlobalProps;
};

/**
 * Full-page Lynx entry. Hosts that own Tab/Nav (Mode B) pass
 * `chromeOwner: 'host'` so this tree does not paint a second dock.
 */
export function App({ host }: AppProps) {
  const resolved = host ?? createHostGlobalProps({ platform: 'android' });
  return <LynxShellApp host={resolved} />;
}
