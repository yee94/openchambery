import React from 'react';
import { useEvent } from '@reactuses/core';

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
import { useUIStore } from '@/stores/useUIStore';
import { QuestionCardFrame } from './QuestionCardFrame';

interface FormCardProps {
  form: SessionFormInfo;
  directory?: string | null;
}

function defaultValue(field: SessionFormField): SessionFormValue | undefined {
  if (field.type === 'external') return undefined;
  if (field.type === 'multiselect') return field.default ?? [];
  if (field.type === 'boolean') return field.default ?? false;
  if (field.type === 'number' || field.type === 'integer') return field.default;
  return field.default ?? (field.type === 'string' ? field.options?.[0]?.value : undefined) ?? '';
}

export const FormCard: React.FC<FormCardProps> = ({ form, directory }) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<'reply' | 'cancel' | null>(null);
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

  const handleReply = useEvent(async () => {
    if (busy) return;
    setFailure(null);
    setBusy(true);
    try {
      await postSessionFormReply({
        sessionID: form.sessionID,
        formID: form.id,
        answer: answers,
        directory,
      });
      useSessionFormStore.getState().remove(form.sessionID, form.id);
    } catch {
      setFailure('reply');
    } finally {
      setBusy(false);
    }
  });

  const handleCancel = useEvent(async () => {
    if (busy) return;
    setFailure(null);
    setBusy(true);
    try {
      await postSessionFormCancel({
        sessionID: form.sessionID,
        formID: form.id,
        directory,
      });
      useSessionFormStore.getState().remove(form.sessionID, form.id);
    } catch {
      setFailure('cancel');
    } finally {
      setBusy(false);
    }
  });

  return (
    <QuestionCardFrame
      mobile={isMobile}
      header={<div className="typography-meta font-medium text-muted-foreground">{form.title || t('chat.form.title')}</div>}
      footer={(
        <>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => void handleReply()}
            disabled={busy}
          >
            {t('chat.form.reply')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void handleCancel()}
            disabled={busy}
          >
            {t('chat.form.cancel')}
          </Button>
        </>
      )}
    >
      <div className="space-y-2">
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
                <div key={field.key} className="space-y-1">
                  <span className="typography-meta text-muted-foreground">{field.title || field.key}</span>
                  {field.description ? <p className="typography-meta text-muted-foreground">{field.description}</p> : null}
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label={field.title || field.key}>
                    {options.map((option) => (
                      <Button key={option.value} type="button" variant="chip" size="sm"
                        aria-pressed={answers[field.key] === option.value}
                        disabled={busy} onClick={() => setValue(field.key, option.value)}>
                        {option.label}
                      </Button>
                    ))}
                  </div>
                  {field.type === 'string' && field.custom ? <Input aria-label={field.title || field.key}
                    value={typeof answers[field.key] === 'string' ? answers[field.key] as string : ''}
                    disabled={busy} onChange={(event) => setValue(field.key, event.target.value)} /> : null}
                </div>
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
      {failure ? <div role="alert" className="mt-2 typography-meta text-[var(--status-error)]">
        {t(failure === 'reply' ? 'chat.questionCard.submitFailed' : 'chat.questionCard.dismissFailed')}
      </div> : null}
    </QuestionCardFrame>
  );
};
