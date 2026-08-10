
export type TargetAspectRatio = '16:9' | '9:16';
export type LayoutType = 'classic-pip' | 'stacked' | 'streamer-only';
export type PipPlacement = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type StackedPlacement = 'top' | 'bottom' | 'left' | 'right';
export type GamingDevice = 'Mobile (Vertical)' | 'Mobile (Horizontal)' | 'PC' | 'Console' | 'Hands-free (No device)';
export type DialoguePacking = 'Slow' | 'Normal' | 'Fast';

export interface GameInfo {
  title: string;
  url: string;
  searchGrounding: boolean;
  cta: string;
  videoFile: File | null;
  gamingDevice: GamingDevice;
  dialoguePacking: DialoguePacking;
  additionalInstructions: string;
  targetAspectRatio: TargetAspectRatio;
  layoutType: LayoutType;
  pipPlacement: PipPlacement;
  stackedPlacement: StackedPlacement;
}

export interface ScriptSection {
  title: string;
  timestamp: string;
  content: string;
  visualCue: string;
}

export interface ScriptResult {
  fullText: string;
  segments: VeoSegment[];
  groundingUrls: string[];
  videoFileUri?: string;
  videoMimeType?: string;
  inlineData?: {
    data: string;
    mimeType: string;
  };
}

export interface AvatarConfig {
  appearance: string;
  setting: string;
  aspectRatio: '16:9' | '9:16';
  referenceImage?: string; // Base64 string — never persisted
  /** gs:// URI of the reference image, so it survives a project restore. */
  referenceImageGcsUri?: string;
  model: 'gemini-3.1-flash-image';
  gamingDevice?: string;
}

/** One generated avatar, kept so it can be reused instead of regenerated. */
export interface AvatarHistoryEntry {
  gcsUri: string;
  prompt: string;
  aspectRatio: '16:9' | '9:16' | null;
  createdAt: number | null;
}

export interface VeoSegment {
  id: number;
  startTime: string;
  endTime: string;
  duration: 4 | 6 | 8; // Strict duration options for Veo 3.1 Fast
  prompt: string;
  dialogue: string;
  // New fields for sequential generation
  videoUrl?: string;
  isGenerating?: boolean;
  generatedAt?: number; // Timestamp to track continuity
  startingFrame?: 'avatar' | 'continuity'; // New field for user preference
  videoOptions?: string[];
  selectedOptionIndex?: number;
  generatedUsingPrevUrl?: string;
  // gs:// URI of the generated clip, so the segment can be restored from
  // history after the in-memory blob URL is gone.
  videoGcsUri?: string;
  videoOptionGcsUris?: (string | undefined)[];
}

/** A finished render that has been persisted to GCS. */
export interface ExportRecord {
  gcsUri: string;
  kind: 'streamer' | 'composite';
  subtitles: boolean;
  aspectRatio: TargetAspectRatio;
  layoutType?: LayoutType;
  fileName: string;
  createdAt: number;
}

/** Summary row used by the history list. */
export interface ProjectSummary {
  id: string;
  name: string;
  gameTitle: string | null;
  gameUrl: string | null;
  targetAspectRatio: TargetAspectRatio | null;
  layoutType: LayoutType | null;
  segmentCount: number;
  exportCount: number;
  hasScript: boolean;
  hasAvatar: boolean;
  avatarImageGcsUri: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

/**
 * Fingerprint of the gameplay video a project's script was generated from.
 * The `File` itself cannot be persisted, so re-attaching it after a restore is
 * unavoidable — this lets the app tell "the same file again" from "a different
 * video", and only invalidate the script in the latter case.
 */
export interface GameplayFileMeta {
  name: string;
  size: number;
  lastModified: number;
}

/** Everything needed to restore a working session. */
export interface ProjectPayload {
  id?: string;
  name: string;
  gameInfo: Omit<GameInfo, 'videoFile'>;
  avatarConfig: AvatarConfig | null;
  scriptText: string | null;
  segments: VeoSegment[];
  exports: ExportRecord[];
  avatarImageGcsUri?: string | null;
  avatarHistory?: AvatarHistoryEntry[];
  gameplayFileMeta?: GameplayFileMeta | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface CurrentUserInfo {
  email: string | null;
  isAdmin: boolean;
  adminEnabled: boolean;
}

export interface StudioState {
    segments: VeoSegment[];
    analyzedScript: string | null;
}

export interface LogEntry {
  userId: string;
  userEmail?: string | null;
  type: 'image' | 'video' | 'script' | 'export';
  model: string;
  timestamp: number;
  status: 'success' | 'failed';
  meta?: any;
}

export interface AdminStats {
  logs: LogEntry[];
}
