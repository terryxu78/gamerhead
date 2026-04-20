
import { GameInfo, ScriptResult, AvatarConfig, VeoSegment } from "../types";
import { 
    constructGeneratorPrompt, 
    constructAvatarPrompt,
    constructVeoAnalysisPrompt,
    constructVeoGenerationPrompt
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
      body: JSON.stringify({ prompt, inlineData: inlineData || null, videoMimeType: finalMimeType })
    });

    if (onStatusUpdate) onStatusUpdate("Finalizing...", 100);
    logEvent('script', 'gemini-3-flash-preview', 'success');
    return {
      fullText: result.fullText,
      segments: result.segments,
      groundingUrls: result.groundingUrls || [],
      videoMimeType: finalMimeType,
      inlineData: result.inlineData || inlineData
    };
  } catch (error: any) {
    logEvent('script', 'gemini-3-flash-preview', 'failed', { error: error.message });
    throw error;
  }
};

// ---------------------------------------------------------------------------
// AVATAR IMAGE GENERATION (Nano2 / gemini image model)
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
// SCRIPT → VEO SHOT LIST ANALYSIS
// ---------------------------------------------------------------------------
export const analyzeScriptForVeo = async (script: string): Promise<VeoSegment[]> => {
  const prompt = constructVeoAnalysisPrompt(script);

  try {
    const segments = await apiFetch('/api/gemini/analyze-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });

    logEvent('script', 'gemini-3-flash-preview', 'success', { segments: segments.length });
    return segments;
  } catch (error: any) {
    logEvent('script', 'gemini-3-flash-preview', 'failed', { error: error.message });
    throw new Error(`Failed to analyze script for video generation: ${error.message}`);
  }
};

// ---------------------------------------------------------------------------
// VEO VIDEO CLIP GENERATION
// ---------------------------------------------------------------------------
export const generateVeoClip = async (
  prompt: string,
  dialogue: string,
  imageBase64: string,
  aspectRatio: '16:9' | '9:16',
  durationSeconds: 4 | 6 | 8,
  model: 'veo-3.1-generate-001' | 'veo-3.1-fast-generate-001',
  signal?: AbortSignal
): Promise<string> => {
  const refinedPrompt = constructVeoGenerationPrompt(prompt, dialogue, durationSeconds);

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  // Step 1: Start video generation — returns operation name
  let operationName: string;
  try {
    // Strip data URI prefix from imageBase64 if present
    const rawImageBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;

    const startResult = await apiFetch('/api/gemini/generate-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        prompt: refinedPrompt,
        imageBase64: rawImageBase64,
        aspectRatio,
        durationSeconds,
        model
      })
    });
    operationName = startResult.operationName;
  } catch (err: any) {
    if (err.name === 'AbortError') throw err;
    logEvent('video', model, 'failed', { error: err.message });
    throw err;
  }

  // Step 2: Poll for operation completion (max 180 seconds)
  const MAX_POLL_MS = 180_000;
  const pollStartTime = Date.now();
  while (true) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (Date.now() - pollStartTime > MAX_POLL_MS) {
      throw new Error(`Video generation timed out after 180 seconds. The operation may still be running.`);
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    let pollResult: any;
    try {
      pollResult = await apiFetch(
        `/api/gemini/video-operation?name=${encodeURIComponent(operationName)}`,
        { signal }
      );
    } catch (err: any) {
      if (err.name === 'AbortError') throw err;
      logEvent('video', model, 'failed', { error: err.message });
      throw err;
    }

    if (!pollResult.done) continue;

    if (pollResult.error) {
      logEvent('video', model, 'failed', { error: pollResult.error });
      throw new Error(`Video generation failed: ${pollResult.error}`);
    }

    // Step 3a: Server returned inline base64 video (no GCS URI)
    if (pollResult.videoBase64) {
      logEvent('video', model, 'success', { duration: durationSeconds });
      return pollResult.videoBase64; // data:video/mp4;base64,... — usable directly in <video src>
    }

    const videoUri: string = pollResult.videoUri;
    if (!videoUri) throw new Error("Video generation completed but no URI returned.");

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    // Step 3b: Download video through server proxy (uses ADC Bearer token)
    try {
      const downloadUrl = `/api/gemini/download-video?uri=${encodeURIComponent(videoUri)}`;
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
      logEvent('video', model, 'success', {
        duration: durationSeconds,
        gcsUri: videoUri.startsWith('gs://') ? videoUri : undefined,
      });
      return URL.createObjectURL(blob);
    } catch (err: any) {
      if (err.name === 'AbortError') throw err;
      logEvent('video', model, 'failed', { error: err.message });
      throw new Error(`Download error: ${err.message}`);
    }
  }
};
