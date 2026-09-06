import { tabLabel } from '../../i18n/catalog';
import { StubPage } from './StubPage';

export function AssistantTab({ locale }: { locale: string }) {
  return (
    <StubPage
      locale={locale}
      title={tabLabel(locale, 'assistant')}
      bodyKey="lynx.shell.stub.body"
    />
  );
}
