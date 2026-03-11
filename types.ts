
export type TargetAspectRatio = '16:9' | '9:16';
export type LayoutType = 'classic-pip' | 'stacked' | 'streamer-only';
export type PipPlacement = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type StackedPlacement = 'top' | 'bottom' | 'left' | 'right';
export type GamingDevice = 'Mobile (Vertical)' | 'Mobile (Horizontal)' | 'PC' | 'Console';

export interface GameInfo {
  title: string;
  url: string;
  cta: string;
  videoFile: File | null;
  gamingDevice: GamingDevice;
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
  referenceImage?: string; // Base64 string
  model: 'gemini-3.1-flash-image-preview';
  gamingDevice?: string;
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
