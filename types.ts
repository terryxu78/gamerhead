
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
  referenceImage?: string; // Base64 string
  model: 'gemini-3.1-flash-image';
  gamingDevice?: string;
}

export interface OmniTake {
  id: string;
  videoUrl: string;
  dialogue: string;
  prompt: string;
  createdAt: number;
}

export interface OmniSegment {
  id: number;
  startTime: string;
  endTime: string;
  duration: number; // Dynamic duration (3 to 10 seconds)
  prompt: string;
  dialogue: string;
  videoUrl?: string;
  takes?: OmniTake[];
  activeTakeIndex?: number;
  isGenerating?: boolean;
  generatedAt?: number;
  interactionId?: string;
  generatedUsingPrevUrl?: string;
}

// Alias for backwards compatibility across components
export type VeoSegment = OmniSegment;

export interface StudioState {
    segments: OmniSegment[];
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

