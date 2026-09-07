import { useState } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxText, LynxView } from '../lynx-elements';
import { cssVar } from '../theme/tokens';
import {
  buildLynxTurnCard,
  type LynxMessagePart,
  type LynxPermissionRequest,
  type LynxQuestionRequest,
} from './messageParts';
import type { LynxPermissionReply } from './pendingCards';
import {
  formatLynxPermissionMetadataLines,
  getLynxPermissionToolDisplayName,
} from './permissionMetadata';

function FileChip({ part }: { part: Extract<LynxMessagePart, { type: 'file' }> }) {
  return (
    <LynxView
      style={{
        marginTop: '6px',
        padding: '6px 10px',
        borderRadius: '10px',
        backgroundColor: cssVar('surface.elevated'),
      }}
    >
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
        {part.filename || part.mime}
      </LynxText>
    </LynxView>
  );
}

/**
 * Cap chat turn card: user bubble / assistant Activity disclosure + body text.
 * Collapsed Activity hides detail rows (Cap collapsedPreviewCount = 0).
 */
export function LynxTurnCard({
  locale,
  messageId,
  role,
  parts,
  textFallback,
}: {
  locale: string;
  messageId: string;
  role: 'user' | 'assistant' | 'system' | 'unknown';
  parts: readonly LynxMessagePart[];
  textFallback?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const card = buildLynxTurnCard({
    messageId,
    role,
    parts: parts.length > 0
      ? parts
      : (textFallback
        ? [{ type: 'text', id: `${messageId}_text`, text: textFallback }]
        : []),
    activityExpanded: expanded,
  });

  const files = card.parts.filter((part): part is Extract<LynxMessagePart, { type: 'file' }> => part.type === 'file');

  return (
    <LynxView
      style={{ padding: '10px 16px' }}
      accessibility-label={`${role} message`}
    >
      <LynxText
        style={{
          fontSize: '12px',
          color: cssVar('surface.mutedForeground'),
          marginBottom: '4px',
        }}
      >
        {role}
      </LynxText>

      {card.activity ? (
        <LynxView
          style={{
            marginBottom: '8px',
            padding: '10px 12px',
            borderRadius: '12px',
            backgroundColor: cssVar('surface.elevated'),
          }}
        >
          <LynxView
            bindtap={() => setExpanded((value) => !value)}
            accessibility-role="button"
            accessibility-label={lynxT(locale, 'lynx.chat.activity.toggle')}
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '14px', fontWeight: '600' }}>
              {card.activity.headerLabel}
            </LynxText>
            <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
              {expanded ? '▾' : '▸'}
            </LynxText>
          </LynxView>
          {expanded
            ? card.activity.rows.map((row) => (
              <LynxView key={row.id} style={{ marginTop: '8px' }}>
                <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '13px' }}>
                  {row.kind === 'tool' ? `⚙ ${row.label}` : `💭 ${row.label}`}
                  {row.status ? ` · ${row.status}` : ''}
                </LynxText>
              </LynxView>
            ))
            : null}
        </LynxView>
      ) : null}

      {card.bodyText ? (
        <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '15px' }}>
          {card.bodyText}
        </LynxText>
      ) : (!card.activity ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '15px' }}>…</LynxText>
      ) : null)}

      {files.map((file) => <FileChip key={file.id} part={file} />)}
    </LynxView>
  );
}

export function LynxQuestionCard({
  locale,
  question,
  onReply,
  onReject,
  busy,
}: {
  locale: string;
  question: LynxQuestionRequest;
  onReply: (answers: string[][]) => void;
  onReject: () => void;
  busy?: boolean;
}) {
  const first = question.questions[0];
  return (
    <LynxView
      style={{
        margin: '8px 16px',
        padding: '12px',
        borderRadius: '14px',
        backgroundColor: cssVar('surface.elevated'),
      }}
      accessibility-label={lynxT(locale, 'lynx.chat.question.title')}
    >
      <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '700', fontSize: '15px' }}>
        {first?.header || lynxT(locale, 'lynx.chat.question.title')}
      </LynxText>
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '13px', marginTop: '6px' }}>
        {first?.question || ''}
      </LynxText>
      {(first?.options ?? []).map((option) => (
        <LynxView
          key={option.label}
          bindtap={() => {
            if (busy) return;
            onReply([[option.label]]);
          }}
          accessibility-role="button"
          style={{
            marginTop: '8px',
            padding: '8px 10px',
            borderRadius: '10px',
            backgroundColor: cssVar('surface.background'),
            opacity: busy ? 0.6 : 1,
          }}
        >
          <LynxText style={{ color: cssVar('primary.base'), fontSize: '14px' }}>{option.label}</LynxText>
          {option.description ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '2px' }}>
              {option.description}
            </LynxText>
          ) : null}
        </LynxView>
      ))}
      <LynxView
        bindtap={() => { if (!busy) onReject(); }}
        accessibility-role="button"
        style={{ marginTop: '10px', opacity: busy ? 0.6 : 1 }}
      >
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '13px' }}>
          {lynxT(locale, 'lynx.chat.question.reject')}
        </LynxText>
      </LynxView>
    </LynxView>
  );
}

export function LynxPermissionCard({
  locale,
  permission,
  onReply,
  busy,
}: {
  locale: string;
  permission: LynxPermissionRequest;
  onReply: (reply: LynxPermissionReply) => void;
  busy?: boolean;
}) {
  const actions: Array<{ reply: LynxPermissionReply; labelKey: 'lynx.chat.permission.once' | 'lynx.chat.permission.always' | 'lynx.chat.permission.reject' }> = [
    { reply: 'once', labelKey: 'lynx.chat.permission.once' },
    { reply: 'always', labelKey: 'lynx.chat.permission.always' },
    { reply: 'reject', labelKey: 'lynx.chat.permission.reject' },
  ];
  const displayTool = getLynxPermissionToolDisplayName(permission.permission);
  const metadataLines = formatLynxPermissionMetadataLines({
    permission: permission.permission,
    metadata: permission.metadata,
  });
  const patternPreview = permission.patterns.slice(0, 3);
  return (
    <LynxView
      style={{
        margin: '8px 16px',
        padding: '12px',
        borderRadius: '14px',
        backgroundColor: cssVar('surface.elevated'),
      }}
      accessibility-label={lynxT(locale, 'lynx.chat.permission.title')}
    >
      <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '700', fontSize: '15px' }}>
        {lynxT(locale, 'lynx.chat.permission.title')}
      </LynxText>
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '13px', marginTop: '6px' }}>
        {displayTool}
        {patternPreview.length > 0 ? ` · ${patternPreview.join(', ')}` : ''}
      </LynxText>
      {permission.patterns.length > 0 ? (
        <LynxView style={{ marginTop: '8px' }}>
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '11px', marginBottom: '4px' }}>
            {lynxT(locale, 'lynx.chat.permission.patterns')}
          </LynxText>
          {permission.patterns.map((pattern, index) => (
            <LynxText
              key={`${pattern}-${index}`}
              style={{ color: cssVar('surface.foreground'), fontSize: '12px', marginTop: index > 0 ? '2px' : '0' }}
            >
              {pattern}
            </LynxText>
          ))}
        </LynxView>
      ) : null}
      {metadataLines.length > 0 ? (
        <LynxView style={{ marginTop: '8px' }}>
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '11px', marginBottom: '4px' }}>
            {lynxT(locale, 'lynx.chat.permission.details')}
          </LynxText>
          {metadataLines.map((line) => (
            <LynxView key={`${line.label}:${line.value.slice(0, 24)}`} style={{ marginTop: '4px' }}>
              <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '11px', fontWeight: '600' }}>
                {line.label}
              </LynxText>
              <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '12px' }}>
                {line.value}
              </LynxText>
            </LynxView>
          ))}
        </LynxView>
      ) : null}
      <LynxView style={{ flexDirection: 'row', marginTop: '10px' }}>
        {actions.map((action) => (
          <LynxView
            key={action.reply}
            bindtap={() => { if (!busy) onReply(action.reply); }}
            accessibility-role="button"
            style={{
              marginRight: '10px',
              padding: '8px 10px',
              borderRadius: '10px',
              backgroundColor: cssVar('surface.background'),
              opacity: busy ? 0.6 : 1,
            }}
          >
            <LynxText style={{
              color: action.reply === 'reject' ? cssVar('surface.mutedForeground') : cssVar('primary.base'),
              fontSize: '13px',
            }}
            >
              {lynxT(locale, action.labelKey)}
            </LynxText>
          </LynxView>
        ))}
      </LynxView>
    </LynxView>
  );
}
