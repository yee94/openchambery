import { tabLabel } from '../../i18n/catalog';
import { StubPage } from './StubPage';

export function ScheduledTab({ locale }: { locale: string }) {
  return (
    <StubPage
      locale={locale}
      title={tabLabel(locale, 'scheduled')}
      bodyKey="lynx.shell.stub.body"
    />
  );
}
