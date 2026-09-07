/**
 * Cap MobileShareRecipientPicker — full-page overlay (never a sheet).
 * Plain Lynx views only — no react-dom Dialog / Shadow DOM.
 */
import { lynxT } from '../i18n/catalog';
import { LynxScrollView, LynxText, LynxView } from '../lynx-elements';
import { LynxDialogPortal } from '../shell/DialogPortal';
import { cssVar } from '../theme/tokens';
import {
  avatarGlyphForLynxShareEntry,
  displayNameForLynxShareEntry,
  type LynxShareCatalogEntry,
  type LynxShareDraft,
} from './shareDraft';

export type LynxShareRecipientPickerProps = {
  locale: string;
  draft: LynxShareDraft | null;
  entries: LynxShareCatalogEntry[];
  busy: boolean;
  onSelect: (draft: LynxShareDraft, entry: LynxShareCatalogEntry) => void;
  onCancel: (draft: LynxShareDraft) => void;
};

/**
 * Full-page Dialog spirit via shell portal. Cap Android Share UX: never a sheet.
 */
export function LynxShareRecipientPicker({
  locale,
  draft,
  entries,
  busy,
  onSelect,
  onCancel,
}: LynxShareRecipientPickerProps) {
  if (!draft) return null;

  const handleCancel = () => {
    if (!busy) onCancel(draft);
  };

  return (
    <LynxDialogPortal>
      <LynxView
        data-lynx-share-recipient-picker="full-page"
        data-lynx-share-recipient-placement="full-page-overlay"
        style={{
          position: 'absolute',
          left: '0',
          right: '0',
          top: '0',
          bottom: '0',
          backgroundColor: cssVar('surface.background'),
          zIndex: '50',
        }}
        accessibility-label={lynxT(locale, 'lynx.share.recipient.title')}
      >
        <LynxView
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            padding: '12px 12px',
            borderBottomWidth: '1px',
            borderBottomColor: cssVar('surface.elevated'),
          }}
        >
          <LynxView
            bindtap={handleCancel}
            accessibility-role="button"
            accessibility-label={lynxT(locale, 'lynx.share.recipient.cancel')}
            style={{
              minWidth: '64px',
              padding: '8px 4px',
              opacity: busy ? '0.4' : '1',
            }}
          >
            <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '16px' }}>
              {lynxT(locale, 'lynx.share.recipient.cancel')}
            </LynxText>
          </LynxView>
          <LynxText
            style={{
              flexGrow: 1,
              textAlign: 'center',
              color: cssVar('surface.foreground'),
              fontSize: '17px',
              fontWeight: '600',
            }}
          >
            {lynxT(locale, 'lynx.share.recipient.title')}
          </LynxText>
          <LynxView style={{ minWidth: '64px' }} />
        </LynxView>

        {entries.length === 0 ? (
          <LynxText
            style={{
              padding: '24px 20px',
              color: cssVar('surface.mutedForeground'),
              fontSize: '15px',
            }}
          >
            {lynxT(locale, 'lynx.share.recipient.unavailable')}
          </LynxText>
        ) : (
          <LynxScrollView
            accessibility-label={lynxT(locale, 'lynx.share.recipient.listAria')}
            style={{ flexGrow: 1, paddingBottom: '16px' }}
          >
            {entries.map((entry) => {
              const displayName = displayNameForLynxShareEntry(entry);
              return (
                <LynxView
                  key={`${entry.connectionKey}:${entry.assistantID}`}
                  bindtap={() => {
                    if (!busy) onSelect(draft, entry);
                  }}
                  accessibility-role="button"
                  accessibility-label={displayName}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    padding: '14px 16px',
                    borderBottomWidth: '1px',
                    borderBottomColor: cssVar('surface.elevated'),
                    opacity: busy ? '0.55' : '1',
                  }}
                >
                  <LynxView
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '18px',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: cssVar('surface.elevated'),
                      marginRight: '12px',
                    }}
                  >
                    <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600' }}>
                      {avatarGlyphForLynxShareEntry(entry)}
                    </LynxText>
                  </LynxView>
                  <LynxView style={{ flexGrow: 1, minWidth: '0' }}>
                    <LynxText
                      style={{
                        color: cssVar('surface.foreground'),
                        fontSize: '16px',
                        fontWeight: '600',
                      }}
                    >
                      {displayName}
                    </LynxText>
                    <LynxText
                      style={{
                        color: cssVar('surface.mutedForeground'),
                        fontSize: '13px',
                        marginTop: '2px',
                      }}
                    >
                      {entry.serverLabel}
                    </LynxText>
                  </LynxView>
                  <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '16px' }}>
                    ›
                  </LynxText>
                </LynxView>
              );
            })}
          </LynxScrollView>
        )}
      </LynxView>
    </LynxDialogPortal>
  );
}
