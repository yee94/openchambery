import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/lib/i18n';
import {
  postSessionFormCancel,
  postSessionFormReply,
  type SessionFormAnswer,
  type SessionFormField,
  type SessionFormInfo,
  type SessionFormValue,
} from '@/sync/session-form-api';
import { useSessionFormStore } from '@/sync/session-form-store';

interface FormCardProps {
  form: SessionFormInfo;
  directory?: string | null;
}

function defaultValue(field: SessionFormField): SessionFormValue | undefined {
  if (field.type === 'external') return undefined;
  if (field.type === 'multiselect') return field.default ?? [];
  if (field.type === 'boolean') return field.default ?? false;
  if (field.type === 'number' || field.type === 'integer') return field.default;
  return field.default ?? '';
}

export const FormCard: React.FC<FormCardProps> = ({ form, directory }) => {
  const { t } = useI18n();
  const [busy, setBusy] = React.useState(false);
  const [answers, setAnswers] = React.useState<SessionFormAnswer>(() => {
    const initial: SessionFormAnswer = {};
    for (const field of form.fields) {
      const value = defaultValue(field);
      if (value !== undefined) initial[field.key] = value;
    }
    return initial;
  });

  const setValue = (key: string, value: SessionFormValue) => {
    setAnswers((current) => ({ ...current, [key]: value }));
  };

  const handleReply = async () => {
    setBusy(true);
    try {
      await postSessionFormReply({
        sessionID: form.sessionID,
        formID: form.id,
        answer: answers,
        directory,
      });
      useSessionFormStore.getState().remove(form.sessionID, form.id);
    } catch (error) {
      console.error('[FormCard] Failed to reply to form:', error);
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    setBusy(true);
    try {
      await postSessionFormCancel({
        sessionID: form.sessionID,
        formID: form.id,
        directory,
      });
      useSessionFormStore.getState().remove(form.sessionID, form.id);
    } catch (error) {
      console.error('[FormCard] Failed to cancel form:', error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-2 rounded-xl border border-border/20 bg-muted/10">
      <div className="px-2.5 py-2 sm:px-3">
        <div className="typography-ui-label text-foreground">{form.title || t('chat.form.title')}</div>
        <div className="mt-2 space-y-2">
          {form.fields.map((field) => {
            if (field.type === 'external') {
              return (
                <a
                  key={field.key}
                  href={field.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block typography-meta text-primary underline"
                >
                  {field.title || field.url}
                </a>
              );
            }
            if (field.type === 'boolean') {
              return (
                <label key={field.key} className="flex items-center gap-2 typography-meta">
                  <Checkbox
                    checked={Boolean(answers[field.key])}
                    onChange={(checked) => setValue(field.key, checked)}
                    disabled={busy}
                  />
                  <span>{field.title || field.key}</span>
                </label>
              );
            }
            if (field.type === 'multiselect') {
              const selected = Array.isArray(answers[field.key]) ? answers[field.key] as string[] : [];
              return (
                <div key={field.key} className="space-y-1">
                  <div className="typography-meta text-muted-foreground">{field.title || field.key}</div>
                  {field.options.map((option) => (
                    <label key={option.value} className="flex items-center gap-2 typography-meta">
                      <Checkbox
                        checked={selected.includes(option.value)}
                        onChange={(checked) => {
                          const next = checked
                            ? [...selected, option.value]
                            : selected.filter((item) => item !== option.value);
                          setValue(field.key, next);
                        }}
                        disabled={busy}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              );
            }
            if (field.type === 'number' || field.type === 'integer') {
              return (
                <label key={field.key} className="block space-y-1">
                  <span className="typography-meta text-muted-foreground">{field.title || field.key}</span>
                  <Input
                    type="number"
                    value={typeof answers[field.key] === 'number' ? String(answers[field.key]) : ''}
                    onChange={(event) => setValue(field.key, event.target.value === '' ? '' : Number(event.target.value))}
                    disabled={busy}
                  />
                </label>
              );
            }
            const options = field.type === 'string' ? field.options : undefined;
            if (options && options.length > 0) {
              return (
                <label key={field.key} className="block space-y-1">
                  <span className="typography-meta text-muted-foreground">{field.title || field.key}</span>
                  <select
                    className="h-8 w-full rounded-md border border-border/30 bg-transparent px-2 typography-meta"
                    value={typeof answers[field.key] === 'string' ? answers[field.key] as string : ''}
                    onChange={(event) => setValue(field.key, event.target.value)}
                    disabled={busy}
                  >
                    {options.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
              );
            }
            return (
              <label key={field.key} className="block space-y-1">
                <span className="typography-meta text-muted-foreground">{field.title || field.key}</span>
                <Input
                  value={typeof answers[field.key] === 'string' ? answers[field.key] as string : ''}
                  placeholder={field.type === 'string' ? field.placeholder : undefined}
                  onChange={(event) => setValue(field.key, event.target.value)}
                  disabled={busy}
                />
              </label>
            );
          })}
        </div>
      </div>
      <div className="flex items-center gap-1.5 border-t border-border/20 px-2 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void handleReply()}
          disabled={busy}
          className="h-8 px-2 !text-xs"
        >
          {t('chat.form.reply')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void handleCancel()}
          disabled={busy}
          className="h-8 px-2 !text-xs text-[var(--status-error)]"
        >
          {t('chat.form.cancel')}
        </Button>
      </div>
    </div>
  );
};
