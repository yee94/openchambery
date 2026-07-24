import React from "react";
import { OpenChamberVisualSettings } from "./OpenChamberVisualSettings";
import { AboutSettings } from "./AboutSettings";
import { SessionRetentionSettings } from "./SessionRetentionSettings";
import { PasskeySettings } from "./PasskeySettings";
import { DefaultsSettings } from "./DefaultsSettings";
import { SummarySettings } from "./SummarySettings";
import { GitSettings } from "./GitSettings";
import { NotificationSettings } from "./NotificationSettings";
import { GitHubSettings } from "./GitHubSettings";
import { VoiceSettings } from "./VoiceSettings";
import { TunnelSettings } from "./TunnelSettings";
import { OpenCodeCliSettings } from "./OpenCodeCliSettings";
import { DesktopNetworkSettings } from "./DesktopNetworkSettings";
import { KeyboardShortcutsSettings } from "./KeyboardShortcutsSettings";
import { ScrollableOverlay } from "@/components/ui/ScrollableOverlay";
import { useDeviceInfo } from "@/lib/device";
import {
  isDesktopLocalOriginActive,
  isDesktopShell,
  isVSCodeRuntime,
  isWebRuntime,
  usesFramelessElectronChrome,
} from "@/lib/desktop";
import { subscribeRuntimeEndpointChanged } from "@/lib/runtime-switch";
import type { OpenChamberSection } from "./types";

const useRuntimeEndpointEpoch = (): number => {
  const [epoch, setEpoch] = React.useState(0);

  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged(() =>
      setEpoch((current) => current + 1),
    );
  }, []);

  return epoch;
};

interface OpenChamberPageProps {
  /** Which section to display. If undefined, shows all sections (mobile/legacy behavior) */
  section?: OpenChamberSection;
  /** Let the enclosing mobile tab own the vertical scroll region. */
  flowMobile?: boolean;
}

export const OpenChamberPage: React.FC<OpenChamberPageProps> = ({
  section,
  flowMobile = false,
}) => {
  const { isMobile } = useDeviceInfo();
  const runtimeEndpointEpoch = useRuntimeEndpointEpoch();
  const showAbout = isMobile && isWebRuntime();
  const isVSCode = isVSCodeRuntime();
  void runtimeEndpointEpoch;
  const showDesktopNetworkSettings =
    isDesktopShell() &&
    (isDesktopLocalOriginActive() || usesFramelessElectronChrome());

  // If no section specified, show all (mobile/legacy behavior)
  if (!section) {
    return (
      <ScrollableOverlay outerClassName="h-full" className="w-full">
        <div className="oc-settings-page-content openchamber-page-body mx-auto max-w-3xl p-3 sm:p-6 sm:pt-8">
          <OpenChamberVisualSettings />
          <div className="oc-settings-page-section">
            <DefaultsSettings />
          </div>
          <div className="oc-settings-page-section">
            <SummarySettings />
          </div>
          {showDesktopNetworkSettings && (
            <div className="oc-settings-page-section">
              <DesktopNetworkSettings />
            </div>
          )}
          {!isVSCode && (
            <div className="oc-settings-page-section">
              <OpenCodeCliSettings />
            </div>
          )}
          <div className="oc-settings-page-section">
            <SessionRetentionSettings />
          </div>
          <div className="oc-settings-page-section">
            <PasskeySettings />
          </div>
          {showAbout && (
            <div className="oc-settings-page-section">
              <AboutSettings />
            </div>
          )}
        </div>
      </ScrollableOverlay>
    );
  }

  // Show specific section content
  const renderSectionContent = () => {
    switch (section) {
      case "visual":
        return <VisualSectionContent mobile={flowMobile} />;
      case "chat":
        return <ChatSectionContent />;
      case "sessions":
        return <SessionsSectionContent />;
      case "summary-ai":
        return <SummarySettings />;
      case "shortcuts":
        return <ShortcutsSectionContent />;
      case "git":
        return <GitSectionContent />;
      case "github":
        return <GitHubSectionContent />;
      case "notifications":
        return <NotificationSectionContent />;
      case "voice":
        return <VoiceSectionContent />;
      case "tunnel":
        return <TunnelSectionContent />;
      default:
        return null;
    }
  };

  const pageBody = (
    <div className="oc-settings-page-content openchamber-page-body mx-auto max-w-3xl p-3 sm:p-6 sm:pt-8">
      {renderSectionContent()}
    </div>
  );

  if (flowMobile) {
    return pageBody;
  }

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      {pageBody}
    </ScrollableOverlay>
  );
};

const ShortcutsSectionContent: React.FC = () => {
  return <KeyboardShortcutsSettings />;
};

// Visual section: Theme Mode, Font Size, Spacing, Input Bar Offset (mobile), Nav Rail
interface VisualSectionContentProps {
  mobile?: boolean;
}

const VisualSectionContent: React.FC<VisualSectionContentProps> = ({ mobile }) => {
  const isVSCode = isVSCodeRuntime();
  return (
    <OpenChamberVisualSettings
      mobile={mobile}
      visibleSettings={[
        "theme",
        "sidebarBrand",
        "pwaInstallName",
        "pwaOrientation",
        "mobileKeyboardMode",
        "timeFormat",
        ...(!isVSCode ? ["weekStart" as const] : []),
        "fontSize",
        "codeFontSize",
        "terminalFontSize",
        "editorFontSize",
        "fileEditorKeymap",
        "spacing",
        "inputBarOffset",
        "expandedEditorToolbar",
        ...(!isVSCode ? ["terminalQuickKeys" as const] : []),
        "reportUsage",
      ]}
    />
  );
};

// Chat section: User message rendering, Diff layout, Mobile status bar, Show reasoning traces, Follow-up behavior, Persist draft
const ChatSectionContent: React.FC = () => {
  const isVSCode = isVSCodeRuntime();
  return (
    <OpenChamberVisualSettings
      visibleSettings={[
        "sessionGoal",
        "sessionAssist",
        "chatRenderMode",
        "messageTransport",
        "activityRenderMode",
        "userMessageRendering",
        "mermaidRendering",
        "reasoning",
        "showToolFileIcons",
        "showTurnChangedFiles",
        "expandedTools",
        "collapsibleUserMessages",
        "stickyUserHeader",
        ...(!isVSCode ? ["promptNavigatorEnabled" as const] : []),
        "wideChatLayout",
        "codeBlockLineWrap",
        "splitAssistantMessageActions",
        "subagentReadOnlyBanner",
        "diffLayout",
        "dotfiles",
        "fileViewerPreview",
        "followUpBehavior",
        "persistDraft",
        "inputSpellcheck",
      ]}
    />
  );
};

// Sessions section: Default model & agent, Session retention
const SessionsSectionContent: React.FC = () => {
  const isVSCode = isVSCodeRuntime();
  const runtimeEndpointEpoch = useRuntimeEndpointEpoch();
  void runtimeEndpointEpoch;
  const showDesktopNetworkSettings =
    isDesktopShell() &&
    (isDesktopLocalOriginActive() || usesFramelessElectronChrome());
  return (
    <div className="oc-settings-section-stack">
      <DefaultsSettings />
      {showDesktopNetworkSettings && (
        <div className="oc-settings-page-section">
          <DesktopNetworkSettings />
        </div>
      )}
      {!isVSCode && (
        <div className="oc-settings-page-section">
          <OpenCodeCliSettings />
        </div>
      )}
      <div className="oc-settings-page-section">
        <SessionRetentionSettings />
      </div>
      <div className="oc-settings-page-section">
        <PasskeySettings />
      </div>
    </div>
  );
};

// Git section: Commit message model, Worktree settings
const GitSectionContent: React.FC = () => {
  return (
    <div className="oc-settings-section-stack">
      <GitSettings />
    </div>
  );
};

// GitHub section: Connect account for PR/issue workflows
const GitHubSectionContent: React.FC = () => {
  if (isVSCodeRuntime()) {
    return null;
  }
  return <GitHubSettings />;
};

// Notifications section: Native browser notifications
const NotificationSectionContent: React.FC = () => {
  return <NotificationSettings />;
};

// Voice section: Language selection and continuous mode
const VoiceSectionContent: React.FC = () => {
  if (isVSCodeRuntime()) {
    return null;
  }
  return <VoiceSettings />;
};

const TunnelSectionContent: React.FC = () => {
  if (isVSCodeRuntime()) {
    return null;
  }
  return <TunnelSettings />;
};
