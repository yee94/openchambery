import type { IconName } from '@/components/icon/icons';

export type SlashCommandIconInput = {
  name: string;
  isBuiltIn?: boolean;
};

export type FileMentionIconInput = {
  isDirectory?: boolean;
  extension?: string | null;
};

export const resolveSlashCommandIconName = (command: SlashCommandIconInput): IconName => {
  switch (command.name) {
    case 'new':
      return 'add';
    case 'init':
      return 'file';
    case 'undo':
      return 'arrow-go-back';
    case 'redo':
      return 'arrow-go-forward';
    case 'timeline':
      return 'time';
    case 'compact':
      return 'scissors';
    case 'goal':
      return 'target';
    case 'review':
      return 'search-eye';
    case 'test':
    case 'build':
    case 'run':
      return 'terminal-box';
    default:
      if (command.isBuiltIn) return 'flashlight';
      return 'command';
  }
};

export const resolveSkillIconName = (): IconName => 'book-open';

export const resolveFileMentionIconName = (file: FileMentionIconInput): IconName => {
  if (file.isDirectory) return 'folder-3-fill';
  switch (file.extension?.toLowerCase()) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'json':
      return 'code';
    case 'md':
    case 'mdx':
      return 'file';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
      return 'file-image';
    default:
      return 'file-pdf';
  }
};

export const resolveAgentMentionIconName = (): IconName => 'ai-agent';

export const resolveSessionMentionIconName = (): IconName => 'chat-thread';
