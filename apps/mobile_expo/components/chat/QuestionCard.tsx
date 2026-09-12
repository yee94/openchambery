/**
 * Minimal Cap QuestionCard for Expo — options + optional custom text + submit/dismiss.
 * Skips copy-as-markdown/json and multi-question summary tab chrome.
 */

import React, { memo, useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import type { QuestionRequest } from '@/lib/questionApi';
import { t } from '@/lib/i18n';

export type QuestionCardProps = {
  question: QuestionRequest;
  busy?: boolean;
  onSubmit: (answers: string[][]) => void | Promise<void>;
  onDismiss: () => void | Promise<void>;
};

function QuestionCardImpl({ question, busy = false, onSubmit, onDismiss }: QuestionCardProps) {
  const scheme = useColorScheme();
  const colors = Colors[scheme];
  const textColor = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const questions = useMemo(() => question.questions ?? [], [question.questions]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedOptions, setSelectedOptions] = useState<Record<number, string[]>>({});
  const [customMode, setCustomMode] = useState<Record<number, boolean>>({});
  const [customText, setCustomText] = useState<Record<number, string>>({});

  const active = questions[Math.max(0, Math.min(questions.length - 1, activeIndex))] ?? null;
  const isMultiple = Boolean(active?.multiple);
  const selectedForActive = selectedOptions[activeIndex] ?? [];
  const customActive = Boolean(customMode[activeIndex]);

  const requiredSatisfied = useMemo(() => {
    if (questions.length === 0) return false;
    for (let index = 0; index < questions.length; index += 1) {
      if (customMode[index]) {
        if (!(customText[index] ?? '').trim()) return false;
        continue;
      }
      if ((selectedOptions[index] ?? []).length === 0) return false;
    }
    return true;
  }, [customMode, customText, questions.length, selectedOptions]);

  const toggleOption = useCallback(
    (label: string) => {
      if (!active) return;
      setCustomMode((prev) => ({ ...prev, [activeIndex]: false }));
      setSelectedOptions((prev) => {
        const current = prev[activeIndex] ?? [];
        if (isMultiple) {
          const next = current.includes(label)
            ? current.filter((entry) => entry !== label)
            : [...current, label];
          return { ...prev, [activeIndex]: next };
        }
        return { ...prev, [activeIndex]: [label] };
      });
    },
    [active, activeIndex, isMultiple],
  );

  const buildAnswers = useCallback((): string[][] => {
    return questions.map((_, index) => {
      if (customMode[index]) {
        const value = (customText[index] ?? '').trim();
        return value ? [value] : [];
      }
      return selectedOptions[index] ?? [];
    });
  }, [customMode, customText, questions, selectedOptions]);

  const handleSubmit = useCallback(() => {
    if (!requiredSatisfied || busy) return;
    void onSubmit(buildAnswers());
  }, [buildAnswers, busy, onSubmit, requiredSatisfied]);

  if (questions.length === 0) return null;

  return (
    <RNView style={styles.wrap} accessibilityRole="summary">
      <RNView style={styles.titleRow}>
        <Text style={[styles.badge, { color: muted }]}>
          {t('mobile.chat.question.inputNeeded')}
        </Text>
        {questions.length > 1 ? (
          <Text style={[styles.progress, { color: muted }]}>
            {activeIndex + 1}/{questions.length}
          </Text>
        ) : null}
      </RNView>

      {questions.length > 1 ? (
        <RNView style={styles.tabs}>
          {questions.map((q, index) => (
            <Pressable
              key={`${question.id}_${index}`}
              onPress={() => setActiveIndex(index)}
              style={[styles.tab, index === activeIndex && styles.tabActive]}
            >
              <Text
                style={[
                  styles.tabText,
                  { color: index === activeIndex ? textColor : muted },
                ]}
                numberOfLines={1}
              >
                {q.header?.trim() || t('mobile.chat.question.fallback', { index: index + 1 })}
              </Text>
            </Pressable>
          ))}
        </RNView>
      ) : null}

      {active ? (
        <>
          <Text style={[styles.prompt, { color: textColor }]}>{active.question}</Text>
          {isMultiple ? (
            <Text style={[styles.hint, { color: muted }]}>
              {t('mobile.chat.question.selectMultiple')}
            </Text>
          ) : null}

          <RNView style={styles.options}>
            {active.options.map((option) => {
              const selected = selectedForActive.includes(option.label) && !customActive;
              return (
                <Pressable
                  key={option.label}
                  onPress={() => toggleOption(option.label)}
                  disabled={busy}
                  style={[styles.option, selected && [styles.optionSelected, { borderColor: colors.tint, backgroundColor: colors.tint + '2e' }]]}
                  accessibilityRole={isMultiple ? 'checkbox' : 'radio'}
                  accessibilityState={{ selected, disabled: busy }}
                >
                  <Text style={[styles.optionLabel, { color: textColor }]}>{option.label}</Text>
                  {option.description ? (
                    <Text style={[styles.optionDesc, { color: muted }]}>{option.description}</Text>
                  ) : null}
                </Pressable>
              );
            })}

            <Pressable
              onPress={() => {
                setCustomMode((prev) => ({ ...prev, [activeIndex]: true }));
                setSelectedOptions((prev) => ({ ...prev, [activeIndex]: [] }));
              }}
              disabled={busy}
              style={[styles.option, customActive && [styles.optionSelected, { borderColor: colors.tint, backgroundColor: colors.tint + '2e' }]]}
            >
              <Text style={[styles.optionLabel, { color: textColor }]}>
                {t('mobile.chat.question.other')}
              </Text>
            </Pressable>

            {customActive ? (
              <TextInput
                value={customText[activeIndex] ?? ''}
                onChangeText={(value) =>
                  setCustomText((prev) => ({ ...prev, [activeIndex]: value }))
                }
                placeholder={t('mobile.chat.question.yourAnswer')}
                placeholderTextColor={muted}
                editable={!busy}
                multiline
                style={[styles.customInput, { color: textColor, borderColor: 'rgba(127,127,127,0.35)' }]}
              />
            ) : null}
          </RNView>
        </>
      ) : null}

      <RNView style={styles.actions}>
        <Pressable
          onPress={() => {
            void onDismiss();
          }}
          disabled={busy}
          style={styles.secondaryBtn}
          accessibilityRole="button"
        >
          <Text style={[styles.secondaryText, { color: muted }]}>
            {t('mobile.chat.question.dismiss')}
          </Text>
        </Pressable>
        {questions.length > 1 && activeIndex < questions.length - 1 && !requiredSatisfied ? (
          <Pressable
            onPress={() => setActiveIndex((i) => Math.min(questions.length - 1, i + 1))}
            disabled={busy}
            style={[styles.primaryBtn, { backgroundColor: colors.tint }]}
          >
            <Text style={[styles.primaryText, { color: colors.primaryForeground }]}>{t('mobile.chat.question.next')}</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={handleSubmit}
            disabled={!requiredSatisfied || busy}
            style={[styles.primaryBtn, { backgroundColor: colors.tint }, (!requiredSatisfied || busy) && styles.primaryDisabled]}
            accessibilityRole="button"
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={[styles.primaryText, { color: colors.primaryForeground }]}>{t('mobile.chat.question.submit')}</Text>
            )}
          </Pressable>
        )}
      </RNView>
    </RNView>
  );
}

export const QuestionCard = memo(QuestionCardImpl);

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(232,119,34,0.45)',
    backgroundColor: 'rgba(232,119,34,0.08)',
    padding: 12,
    gap: 8,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  badge: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  progress: {
    fontSize: 11,
  },
  tabs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  tab: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(127,127,127,0.12)',
  },
  tabActive: {
    backgroundColor: 'rgba(232,119,34,0.25)',
  },
  tabText: {
    fontSize: 12,
    maxWidth: 120,
  },
  prompt: {
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '600',
  },
  hint: {
    fontSize: 12,
  },
  options: {
    gap: 6,
  },
  option: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(127,127,127,0.1)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
  },
  optionSelected: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  optionLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
  optionDesc: {
    marginTop: 2,
    fontSize: 12,
  },
  customInput: {
    minHeight: 64,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    textAlignVertical: 'top',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  secondaryBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  secondaryText: {
    fontSize: 14,
  },
  primaryBtn: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 88,
  },
  primaryDisabled: {
    opacity: 0.45,
  },
  primaryText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
