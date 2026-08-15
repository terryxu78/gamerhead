
import { GameInfo, ScriptResult, AvatarConfig, VeoSegment } from "../types";
import { 
    constructGeneratorPrompt, 
    constructAvatarPrompt,
    constructVeoAnalysisPrompt,
    constructVeoGenerationPrompt,
    constructOmniGenerationPrompt
} from "./prompts";
import { compressVideo } from "../utils/videoUtils";
import { logEvent } from "./logging";
import { apiFetch as authFetch } from "./auth";

// ---------------------------------------------------------------------------
// NOTE: All Gemini / Veo API calls are proxied through the Express backend
// at /api/gemini/* which uses Vertex AI with Application Default Credentials.
// No API key is required on the frontend.
// ---------------------------------------------------------------------------

/**
 * Helper to convert a File/Blob to a Base64 string (raw, no data URI prefix)
 */
const fileToBase64 = (file: File | Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
};

/**
 * Thin wrapper around authFetch that throws on non-OK responses and returns JSON.
 * Handles Bearer token attachment and automatic token refresh on 401.
 */
const apiFetch = async (path: string, options?: RequestInit): Promise<any> => {
    const res = await authFetch(path, options || {});
    if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try {
            const body = await res.json();
            errMsg = body.error || errMsg;
        } catch { /* ignore */ }
        throw new Error(errMsg);
    }
    return res.json();
};

// ---------------------------------------------------------------------------
// SCRIPT GENERATION
// ---------------------------------------------------------------------------
export const generateStreamerScript = async (
  info: GameInfo,
  onStatusUpdate?: (status: string, progress: number) => void,
  cachedInlineData?: { data: string, mimeType: string }
): Promise<ScriptResult> => {
  const prompt = constructGeneratorPrompt(info);
  const finalMimeType = info.videoFile?.type || 'video/mp4';
  let inlineData: { data: string, mimeType: string } | undefined;

  if (info.videoFile) {
    if (cachedInlineData) {
      if (onStatusUpdate) onStatusUpdate("Using cached video...", 50);
      inlineData = cachedInlineData;
    } else {
      if (onStatusUpdate) onStatusUpdate("Optimizing video (compression)...", 15);
      try {
        const compressedBlob = await compressVideo(info.videoFile);
        const FILE_SIZE_LIMIT = 20 * 1024 * 1024;
        if (compressedBlob.size >= FILE_SIZE_LIMIT) {
          const sizeMB = (compressedBlob.size / (1024 * 1024)).toFixed(1);
          throw new Error(`Video too large even after compression (${sizeMB}MB). Limit is 20MB.`);
        }
        if (onStatusUpdate) onStatusUpdate("Encoding video...", 40);
        const base64Data = await fileToBase64(compressedBlob);
        inlineData = { mimeType: compressedBlob.type || 'video/webm', data: base64Data };
      } catch (compErr: any) {
        throw new Error(`Video optimization failed: ${compErr.message}`);
      }
    }
    if (onStatusUpdate) onStatusUpdate("Analyzing visuals...", 70);
  }

  if (onStatusUpdate) onStatusUpdate("Generating script...", 85);

  try {
    const result = await apiFetch('/api/gemini/generate-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        inlineData: inlineData || null,
        videoMimeType: finalMimeType,
        searchGrounding: info.searchGrounding,
        gameUrl: info.url
      })
    });

    if (onStatusUpdate) onStatusUpdate("Finalizing...", 100);
    logEvent('script', 'gemini-3.6-flash', 'success');
    return {
      fullText: result.fullText,
      segments: result.segments,
      groundingUrls: result.groundingUrls || [],
      videoMimeType: finalMimeType,
      inlineData: result.inlineData || inlineData
    };
  } catch (error: any) {
    logEvent('script', 'gemini-3.6-flash', 'failed', { error: error.message });
    throw error;
  }
};

// ---------------------------------------------------------------------------
// AVATAR IMAGE GENERATION (gemini-3.1-flash-image)
// ---------------------------------------------------------------------------
export const generateStreamerAvatar = async (config: AvatarConfig): Promise<string> => {
  const prompt = constructAvatarPrompt(config);

  // Extract reference image data if present
  let referenceImageData: string | undefined;
  let referenceImageMime: string | undefined;
  if (config.referenceImage) {
    referenceImageData = config.referenceImage.split(',')[1];
    referenceImageMime = config.referenceImage.split(';')[0].split(':')[1] || 'image/png';
  }

  try {
    const result = await apiFetch('/api/gemini/generate-avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        model: config.model,
        aspectRatio: config.aspectRatio,
        referenceImageData,
        referenceImageMime
      })
    });

    logEvent('image', config.model, 'success');
    return result.imageData;
  } catch (error: any) {
    logEvent('image', config.model, 'failed', { error: error.message });
    throw error;
  }
};

// ---------------------------------------------------------------------------
// SCRIPT → OMNI SHOT LIST ANALYSIS
// ---------------------------------------------------------------------------
export const analyzeScriptForVeo = async (script: string): Promise<VeoSegment[]> => {
  const prompt = constructVeoAnalysisPrompt(script);

  try {
    const segments = await apiFetch('/api/gemini/analyze-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });

    logEvent('script', 'gemini-3.6-flash', 'success', { segments: segments.length });
    return segments;
  } catch (error: any) {
    logEvent('script', 'gemini-3.6-flash', 'failed', { error: error.message });
    throw new Error(`Failed to analyze script for video generation: ${error.message}`);
  }
};

// ---------------------------------------------------------------------------
// GEMINI OMNI FLASH VIDEO & VOCAL FX GENERATION
// ---------------------------------------------------------------------------
export const generateOmniClip = async (
  prompt: string,
  dialogue: string,
  durationSeconds: number,
  goldenAvatarBase64: string,
  aspectRatio: '16:9' | '9:16',
  gamingDevice?: string,
  prevPoseBase64?: string,
  previousInteractionId?: string,
  signal?: AbortSignal
): Promise<{ videoUrl: string; interactionId: string }> => {
  const rawGoldenAvatar = goldenAvatarBase64
    ? (goldenAvatarBase64.includes(',') ? goldenAvatarBase64.split(',')[1] : goldenAvatarBase64)
    : undefined;
  const rawPrevPose = prevPoseBase64
    ? (prevPoseBase64.includes(',') ? prevPoseBase64.split(',')[1] : prevPoseBase64)
    : undefined;

  const refinedPrompt = constructOmniGenerationPrompt(
    prompt,
    dialogue,
    durationSeconds,
    gamingDevice,
    !!rawPrevPose
  );

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  try {
    const result = await apiFetch('/api/gemini/omni-interaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        prompt: refinedPrompt,
        goldenAvatarBase64: rawGoldenAvatar,
        prevPoseBase64: rawPrevPose,
        aspectRatio,
        durationSeconds
      })
    });

    logEvent('video', 'gemini-omni-flash-preview', 'success', { duration: durationSeconds });

    // Handle base64 video data URL directly
    if (result.videoBase64) {
      return { videoUrl: result.videoBase64, interactionId: result.interactionId };
    }

    // Handle hosted video URI (GCS or Google CDN)
    if (result.videoUri) {
      const downloadUrl = `/api/gemini/download-video?uri=${encodeURIComponent(result.videoUri)}`;
      const token = sessionStorage.getItem('gh_id_token');
      const downloadResp = await fetch(downloadUrl, {
        signal,
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      if (!downloadResp.ok) {
        const errText = await downloadResp.text().catch(() => downloadResp.statusText);
        throw new Error(`Failed to download video (${downloadResp.status}): ${errText}`);
      }
      const blob = await downloadResp.blob();
      return {
        videoUrl: URL.createObjectURL(blob),
        interactionId: result.interactionId
      };
    }

    throw new Error('Omni Flash completed but returned no video stream.');
  } catch (err: any) {
    if (err.name === 'AbortError') throw err;
    logEvent('video', 'gemini-omni-flash-preview', 'failed', { error: err.message });
    throw err;
  }
};

// Backwards compatibility wrapper for generateVeoClip
export const generateVeoClip = async (
  prompt: string,
  dialogue: string,
  imageBase64: string,
  aspectRatio: '16:9' | '9:16',
  durationSeconds: number,
  _model?: any,
  signal?: AbortSignal,
  gamingDevice?: string,
  prevPoseBase64?: string,
  previousInteractionId?: string
): Promise<string> => {
  const res = await generateOmniClip(
    prompt,
    dialogue,
    durationSeconds,
    imageBase64,
    aspectRatio,
    gamingDevice,
    prevPoseBase64,
    previousInteractionId,
    signal
  );
  return res.videoUrl;
};

// ---------------------------------------------------------------------------
// DIRECTOR CO-PILOT (AI Streamer Directing)
// ---------------------------------------------------------------------------
export const directWithCoPilot = async (
  instruction: string,
  currentDialogue: string,
  currentPrompt: string,
  gameTitle?: string
): Promise<{ updatedDialogue: string; updatedPrompt: string; summary: string }> => {
  return await apiFetch('/api/gemini/director-copilot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instruction,
      currentDialogue,
      currentPrompt,
      gameTitle
    })
  });
};


/**
 * Server-side video stitching via FFmpeg.
 * Uploads clip blobs to the server and concatenates them losslessly.
 * If `subtitleSrt` is provided, the server burns it into the stitched video
 * (requires re-encode).
 */
export const stitchClipsServer = async (
    clipUrls: string[],
    onProgress?: (msg: string) => void,
    subtitleSrt?: string,
): Promise<Blob> => {
    const formData = new FormData();

    for (let i = 0; i < clipUrls.length; i++) {
        if (onProgress) onProgress(`Preparing clip ${i + 1} / ${clipUrls.length}...`);
        const resp = await fetch(clipUrls[i]);
        const blob = await resp.blob();
        formData.append('clips', blob, `clip_${i}.mp4`);
    }

    if (subtitleSrt && subtitleSrt.trim()) {
        formData.append('subtitleSrt', subtitleSrt);
        if (onProgress) onProgress('Stitching + burning subtitles...');
    } else {
        if (onProgress) onProgress('Stitching on server...');
    }

    const token = sessionStorage.getItem('gh_id_token');
    const res = await authFetch('/api/gemini/stitch-clips', {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        body: formData,
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(`Stitch failed: ${errText}`);
    }

    return await res.blob();
};

/**
 * Server-side subtitle burn-in on a single final video (typically the composited Mix).
 * Uses the same adaptive style as the stitch endpoint so 16:9 and 9:16 both look right.
 */
export const burnSubtitlesServer = async (
    videoBlob: Blob,
    srt: string,
    onProgress?: (msg: string) => void,
): Promise<Blob> => {
    const formData = new FormData();
    const ext = videoBlob.type.includes('webm') ? 'webm' : 'mp4';
    formData.append('video', videoBlob, `input.${ext}`);
    formData.append('srt', srt);
    if (onProgress) onProgress('Burning subtitles into final video...');

    const token = sessionStorage.getItem('gh_id_token');
    const res = await authFetch('/api/gemini/burn-subtitles', {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        body: formData,
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(`Burn subtitles failed: ${errText}`);
    }
    return res.blob();
};
