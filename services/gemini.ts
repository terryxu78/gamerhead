
import { GoogleGenAI, Type, Part } from "@google/genai";
import { GameInfo, ScriptResult, AvatarConfig, VeoSegment } from "../types";
import { 
    constructGeneratorPrompt, 
    constructAvatarPrompt,
    constructVeoAnalysisPrompt,
    constructVeoGenerationPrompt
} from "./prompts";
import { compressVideo } from "../utils/videoUtils";
import { logEvent } from "./logging";

// Extend window interface for runtime config
declare global {
  interface Window {
    GEMINI_API_KEY?: string;
  }
}

/**
 * Retrieves the effective API Key with enhanced debugging.
 */
export const getEffectiveApiKey = (): string => {
    let key = "";
    let source = "none";

    // 1. Check Runtime Injection (Cloud Run / Docker production)
    if (typeof window !== 'undefined' && window.GEMINI_API_KEY) {
        key = window.GEMINI_API_KEY;
        source = "window.GEMINI_API_KEY";
    }

    // 2. Check Vite Env (Local Development)
    if (!key && import.meta && (import.meta as any).env) {
        const metaEnv = (import.meta as any).env;
        key = metaEnv.VITE_GEMINI_API_KEY || metaEnv.API_KEY || "";
        if (key) source = "import.meta.env";
    }

    // Clean the key
    if (key) {
        key = key.replace(/["']/g, "").trim();
    }

    // Debug logging (Safe: only log first few chars)
    if (key) {
        if (!key.startsWith("AIza")) {
             console.warn(`[Auth] ⚠️ Key from ${source} appears invalid (Starts with: ${key.substring(0,5)}...)`);
        }
    } else {
        console.error(`[Auth] ❌ No API Key found. Checked: window.GEMINI_API_KEY, import.meta.env`);
    }

    return key;
};

/**
 * Ensures a valid API key is selected if running within the AI Studio environment.
 */
const ensureAuth = async () => {
  const win = window as any;
  if (win.aistudio && win.aistudio.hasSelectedApiKey) {
    const hasKey = await win.aistudio.hasSelectedApiKey();
    if (!hasKey) {
       await win.aistudio.openSelectKey();
    }
  }
};

const getAIClient = () => {
  const apiKey = getEffectiveApiKey();
  
  if (!apiKey) {
    throw new Error("API Key not found. Please ensure the GEMINI_API_KEY environment variable is set in your deployment configuration.");
  }

  return new GoogleGenAI({ apiKey });
};

/**
 * Helper to convert a File to a Base64 string (raw, no data URI prefix)
 */
const fileToBase64 = (file: File | Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove data:video/mp4;base64, prefix to get raw base64
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
};

const SAFETY_SETTINGS_BLOCK_NONE = [
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' }
];

export const generateStreamerScript = async (
  info: GameInfo,
  onStatusUpdate?: (status: string, progress: number) => void,
  cachedInlineData?: { data: string, mimeType: string }
): Promise<ScriptResult> => {
  // Ensure Authentication before initializing client or uploading
  await ensureAuth();
  
  const ai = getAIClient();
  const prompt = constructGeneratorPrompt(info);
  const modelName = 'gemini-3-flash-preview';

  const parts: Part[] = [{ text: prompt }];
  
  // Inline Video Data to return for caching
  let inlineDataToReturn: { data: string, mimeType: string } | undefined = undefined;

  // Default to mp4 if type is missing (common browser issue)
  const finalMimeType = info.videoFile?.type || 'video/mp4';

  // If a video file is provided
  if (info.videoFile) {
    
    // 1. Try to use Cached Data first
    if (cachedInlineData) {
        console.log(`Using cached inline video data.`);
        if (onStatusUpdate) onStatusUpdate("Using cached video...", 50);
        
        parts.push({
            inlineData: {
                mimeType: cachedInlineData.mimeType,
                data: cachedInlineData.data
            }
        });
        inlineDataToReturn = cachedInlineData;
    } 
    // 2. Process and Compress for Inline Usage
    else {
        console.log("Compressing and optimizing video for inline usage...");
        if (onStatusUpdate) onStatusUpdate("Optimizing video (compression)...", 15);
        
        let fileToProcess: File | Blob = info.videoFile;
        let fileMimeType = finalMimeType;
        
        try {
            // Compress video (adaptive quality based on duration)
            const compressedBlob = await compressVideo(info.videoFile);
            console.log(`Optimization complete. New size: ${(compressedBlob.size / 1024 / 1024).toFixed(2)}MB`);
            
            const FILE_SIZE_LIMIT_INLINE = 20 * 1024 * 1024; // 20MB Recommended Limit

            if (compressedBlob.size < FILE_SIZE_LIMIT_INLINE) {
                fileToProcess = compressedBlob;
                fileMimeType = compressedBlob.type || 'video/webm'; 
            } else {
                 const sizeMB = (compressedBlob.size / (1024 * 1024)).toFixed(1);
                 throw new Error(`Video too large even after compression (${sizeMB}MB). Limit is 20MB for inline processing.`);
            }
        } catch (compErr: any) {
            console.error("Compression failed:", compErr);
            throw new Error(`Video optimization failed: ${compErr.message}`);
        }

        if (onStatusUpdate) onStatusUpdate("Encoding video...", 40);
        
        try {
            const base64Data = await fileToBase64(fileToProcess);
            
            // Prepare inline data
            const inlineData = {
                mimeType: fileMimeType,
                data: base64Data
            };
            
            parts.push({ inlineData });
            inlineDataToReturn = inlineData;

        } catch (fallbackError) {
            throw new Error(`Failed to encode video for inline processing: ${fallbackError}`);
        }
    }

    if (onStatusUpdate) onStatusUpdate("Analyzing visuals...", 70);
  }

  if (onStatusUpdate) onStatusUpdate("Generating script...", 85);

  try {
    console.log("[GeminiService] Calling generateContent for script...");
    const response = await ai.models.generateContent({
      model: modelName, 
      contents: { parts },
      config: {
        thinkingConfig: { thinkingBudget: 1024 },
        tools: [{ googleSearch: {} }], 
        systemInstruction: "You are an expert content creator scriptwriter. Use the provided context to generate the script.",
      }
    });

    console.log("[GeminiService] generateContent response received.");
    if (onStatusUpdate) onStatusUpdate("Finalizing...", 100);

    const fullText = response.text || "No script generated.";
    
    const groundingUrls: string[] = [];
    if (response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
      response.candidates[0].groundingMetadata.groundingChunks.forEach((chunk: any) => {
        if (chunk.web?.uri) {
          groundingUrls.push(chunk.web.uri);
        }
      });
    }

    logEvent('script', modelName, 'success');
    return { 
      fullText, 
      groundingUrls, 
      videoMimeType: finalMimeType,
      inlineData: inlineDataToReturn
    };

  } catch (error: any) {
    logEvent('script', modelName, 'failed', { error: error.message });
    console.error("Gemini API Error:", error);
    if (error.status === 503 || error.status === 429) {
        throw new Error("Model is overloaded. Please wait a few minutes and try again.");
    }
    throw error;
  }
};

export const generateStreamerAvatar = async (config: AvatarConfig): Promise<string> => {
  await ensureAuth();
  const ai = getAIClient();
  const prompt = constructAvatarPrompt(config);

  const parts: Part[] = [{ text: prompt }];

  if (config.referenceImage) {
      const base64Data = config.referenceImage.split(',')[1];
      const mimeType = config.referenceImage.split(';')[0].split(':')[1] || 'image/png';
      
      parts.push({
          inlineData: {
              mimeType: mimeType,
              data: base64Data
          }
      });
  }

  try {
    console.log(`[GeminiService] Calling generateContent for avatar (${config.model})...`);
    
    const generationConfig: any = {
        temperature: 0.5,
        imageConfig: {
          aspectRatio: config.aspectRatio,
          imageSize: "1K"
        },
        safetySettings: SAFETY_SETTINGS_BLOCK_NONE
    };

    const response = await ai.models.generateContent({
      model: config.model,
      contents: { parts },
      config: generationConfig
    });

    console.log("[GeminiService] Avatar generation response received.");
    if (response.candidates?.[0]?.content?.parts) {
        for (const part of response.candidates[0].content.parts) {
            if (part.inlineData) {
                logEvent('image', config.model, 'success');
                return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            }
        }
    }
    
    throw new Error("No image generated in response");

  } catch (error: any) {
    logEvent('image', config.model, 'failed', { error: error.message });
    console.error("Avatar Generation Error:", error);
    if (error.status === 503 || error.status === 429) {
        throw new Error("Model is overloaded. Please wait a few minutes and try again.");
    }
    throw error;
  }
};

export const analyzeScriptForVeo = async (script: string): Promise<VeoSegment[]> => {
  await ensureAuth();
  const ai = getAIClient();
  const prompt = constructVeoAnalysisPrompt(script);

  try {
    console.log("[GeminiService] Analyzing script for Veo segments...");
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.INTEGER },
              startTime: { type: Type.STRING },
              endTime: { type: Type.STRING },
              duration: { type: Type.INTEGER },
              prompt: { type: Type.STRING },
              dialogue: { type: Type.STRING }
            },
            required: ["id", "startTime", "endTime", "duration", "prompt", "dialogue"]
          }
        }
      }
    });

    console.log("[GeminiService] Script analysis complete.");
    const rawSegments = JSON.parse(response.text || "[]");
    
    const validatedSegments = rawSegments.map((seg: any) => {
        let d = seg.duration;
        if (d <= 4) d = 4;
        else if (d <= 6) d = 6;
        else d = 8;
        return { ...seg, duration: d };
    });

    logEvent('script', 'gemini-3-flash-preview', 'success', { segments: validatedSegments.length });
    return validatedSegments;

  } catch (error: any) {
    logEvent('script', 'gemini-3-flash-preview', 'failed', { error: error.message });
    console.error("Failed to parse Veo segments", error);
    if (error.status === 503 || error.status === 429) {
        throw new Error("Model is overloaded. Please wait a few minutes and try again.");
    }
    throw new Error("Failed to analyze script for video generation.");
  }
};

export const generateVeoClip = async (
  prompt: string,
  dialogue: string,
  imageBase64: string,
  aspectRatio: '16:9' | '9:16',
  durationSeconds: 4 | 6 | 8,
  model: 'veo-3.1-generate-preview' | 'veo-3.1-fast-generate-preview',
  signal?: AbortSignal
): Promise<string> => {
  await ensureAuth();
  const ai = getAIClient();

  const veoRatio = aspectRatio === '9:16' ? '9:16' : '16:9';
  const refinedPrompt = constructVeoGenerationPrompt(prompt, dialogue, durationSeconds);

  const hasDialogue = dialogue && dialogue.trim().length > 0;
  const systemInstruction = `STRICT TECHNICAL CONSTRAINTS (MUST FOLLOW):
1. CAMERA: **TRIPOD SHOT**. LOCKED OFF. ABSOLUTELY NO CAMERA MOVEMENT. NO ZOOM. NO PAN.
2. CONTINUITY: Single continuous take. No cuts.
3. STREAMER GAZE: Eyes stay focused on the monitor/mobile phone (below camera).
4. OVERLAYS: No text, no subtitles, no UI.
5. AUDIO: ${hasDialogue ? 'Speech only.' : 'Silence.'} NO MUSIC. NO SFX.
6. DURATION: Exactly ${durationSeconds} seconds.
7. NEGATIVE PROMPT: No gameplay footage. No video game UI. No HUD. No CGI characters next to streamer. No music. No SFX. No camera movements. No scene cuts. No graphics or animations.
8. [IF APPLICABLE] GAMING PHONE STABILITY: STREAMER DOES NOT ROTATE THE PHONE THAT THEY ARE HOLDING. DEVICE ORIENTATION IS FIXED AT ALL TIMES`;

  try {
    if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
    }

    let operation = await ai.models.generateVideos({
      model: model, 
      prompt: refinedPrompt,
      image: {
        imageBytes: imageBase64.split(',')[1],
        mimeType: 'image/png' 
      },
      config: {
        numberOfVideos: 1,
        resolution: '720p',
        aspectRatio: veoRatio,
        durationSeconds: durationSeconds,
        systemInstruction: systemInstruction,
        // safetySettings not supported in generateVideos config
      }
    });

    while (!operation.done) {
      if (signal?.aborted) {
         throw new DOMException("Aborted", "AbortError");
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
      operation = await ai.operations.getVideosOperation({ operation: operation });
    }

    if (operation.error) {
       console.error("Veo Operation Failed:", operation.error);
       throw new Error(`Video generation failed: ${operation.error.message || 'Unknown API error'}`);
    }

    const generatedVideo = operation.response?.generatedVideos?.[0]?.video;
    
    if (!generatedVideo?.uri) {
      console.error("Veo Response Dump:", JSON.stringify(operation, null, 2));
      throw new Error("Video generation completed but no URI returned.");
    }

    if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
    }

    const apiKey = getEffectiveApiKey();

    if (!apiKey) {
        throw new Error("API Key is missing. Deployment configuration issue.");
    }
    
    console.log(`[GeminiService] Using API Key (last 4 chars): ...${apiKey.slice(-4)}`);

    const uri = generatedVideo.uri;
    
    console.log(`[GeminiService] Downloading Veo clip...`);
    
    try {
        // Use Header-based authentication to avoid URL encoding issues with the key
        const response = await fetch(uri, { 
            signal,
            headers: {
                'x-goog-api-key': apiKey
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text().catch(() => response.statusText);
            console.error(`Veo Download Failed (Status ${response.status}):`, errorText);
            throw new Error(`Failed to download video (Status ${response.status}). Details: ${errorText}`);
        }
        
        const blob = await response.blob();
        logEvent('video', model, 'success', { duration: durationSeconds });
        return URL.createObjectURL(blob);
        
    } catch (downloadError: any) {
        if (downloadError.name === 'AbortError') {
            throw downloadError;
        }
        throw new Error(`Download error: ${downloadError.message}`);
    }

  } catch (error: any) {
    if (error.name !== 'AbortError') {
        logEvent('video', model, 'failed', { error: error.message });
        console.error("Veo Generation Error:", error);
    }
    
    if (error.status === 503 || error.status === 429 || (error.message && error.message.includes('overloaded'))) {
        throw new Error("Model is overloaded. Please wait a few minutes and try again.");
    }

    throw error;
  }
};
