
import { GameInfo, AvatarConfig } from "../types";

// --- SHARED CONSTANTS ---
const BASE_PERSONA = `
You are a top-tier, high-energy gaming livestreamer (Streamer). 
You speak naturally, use gamer slang appropriately (but not cringey), and know how to retain viewers.
Your vibe is professional yet hype. You are NOT a generic AI assistant.
`;

const STREAMER_RULES = `
CRITICAL DURATION & PACING RULES:
1. **TOTAL DURATION**: The sum of all segment durations MUST roughly match the length of the uploaded video.
2. **ROUNDING**: If the total video duration has milliseconds (e.g., 29.3s or 29.8s), ROUND UP the total target script duration to the nearest second (e.g., 30s) to ensure full coverage.
3. **SEGMENTATION**: Break the script into chunks of exactly **4, 6, or 8** seconds.
4. **WORD COUNT LIMITS** (Strict Pacing):
   - **4s Segment**: LESS THAN 20 words. (Short reactions only).
   - **6s Segment**: LESS THAN 25 words.
   - **8s Segment**: LESS THAN 30 words.
5. **TIMESTAMPS**: You must calculate the cumulative timestamp for each segment (e.g., "00:00", "00:06").

VISUAL DESCRIPTION RULES (CRITICAL FOR VEO):
1. **STREAMER ACTION**: Must be EXTREMELY DETAILED (Micro-Expression Level).
   - Describe specific facial features: "Eyes wide open," "Jaw dropped," "Bit lip," "Eyebrows furrowed."
   - Describe body language: "Leans forward aggressively," "Throws head back," "Covers mouth."
   
2. **PURE HUMAN ACTION (NO GAME ELEMENTS)**: 
   - The [Streamer Action] description must be 100% about the human. 
   - **NEVER** mention what is on the screen (e.g. DO NOT say "Reacts to explosion", "Looking at the dragon"). 
   - Instead use physical descriptions: "Reacts with shock", "Staring intensely at screen", "Wincing in pain".

DIALOGUE & AUDIO RULES:
1. **VOCAL EFFECTS**: If the user's "Additional Instructions" request a specific tone (e.g. ASMR, Whispering, Shouting, Crying, Sarcastic), you MUST prefix the dialogue with it in brackets.
   - Example: Streamer Dialogue: "[ASMR whisper] Guys, look at this texture..."
   - Example: Streamer Dialogue: "[Shouting loudly] No way! No way!"
   - This allows the video generation model to produce the correct audio style.

NEGATIVE CONSTRAINTS (DO NOT INCLUDE):
1. DO NOT describe the streamer turning the phone/screen towards the camera/viewers.
2. DO NOT mention music, singing, or dancing.
3. DO NOT describe actions associated with music (e.g. "nodding head to beat").
`;

// --- SCRIPT GENERATION ---
export const constructGeneratorPrompt = (info: GameInfo): string => {
  let deviceInstruction = '';
  if (info.gamingDevice === 'Mobile (Vertical)') {
      deviceInstruction = `EVERY 'prompt' MUST START WITH: "Streamer holds phone VERTICALLY (Portrait) with both hands." followed by the action. Thumbs tapping/swiping.`;
  } else if (info.gamingDevice === 'Mobile (Horizontal)') {
      deviceInstruction = `EVERY 'prompt' MUST START WITH: "Streamer holds phone HORIZONTALLY (Landscape) with both hands." followed by the action. Thumbs tapping.`;
  } else if (info.gamingDevice === 'PC') {
      deviceInstruction = `Ensure descriptions involve keyboard/mouse interaction on a desk.`;
  } else if (info.gamingDevice === 'Console') {
      deviceInstruction = `Ensure descriptions involve holding a standard Gamepad/Controller.`;
  }

  return `
${BASE_PERSONA}

TASK: Create a synchronized gameplay commentary script.

PROJECT CONTEXT:
- Game: "${info.title}"
- URL: "${info.url}"
- CTA: "${info.cta}"
- User Instructions (Style/Tone/Messaging/Streamer Persona/Additional notes): "${info.additionalInstructions}"
- **Gaming Device (Selected by User)**: "${info.gamingDevice}"

CRITICAL INSTRUCTION:
1. **DEVICE AUTHENTICITY**: The user has explicitly selected **${info.gamingDevice}** as the platform. 
   - ${deviceInstruction}
2. **RESEARCH**: Use the **Game URL** to identify unique features, mechanics, or selling points of the game. Incorporate these specific details into the [Streamer Dialogue] to make the commentary authentic and knowledgeable.
3. If 'User Instructions' imply a specific voice style (ASMR, Screaming, etc), apply it to the [Streamer Dialogue] in brackets.

${STREAMER_RULES}
`;
};

// --- AVATAR GENERATION ---
export const constructAvatarPrompt = (config: AvatarConfig): string => {
  const hasRef = !!config.referenceImage;
  
  let deviceInstruction = '';
  if (config.gamingDevice) {
      if (config.gamingDevice === 'Mobile (Vertical)') {
          deviceInstruction = `\n- Action: Streamer is holding and playing a mobile phone vertically (portrait mode). Only back of phone is visible`;
      } else if (config.gamingDevice === 'Mobile (Horizontal)') {
          deviceInstruction = `\n- Action: Streamer is holding and playing a mobile phone horizontally (landscape mode). Only back of phone is visible`;
      } else if (config.gamingDevice === 'PC') {
          deviceInstruction = `\n- Action: Streamer is using a keyboard and mouse.`;
      } else if (config.gamingDevice === 'Console') {
          deviceInstruction = `\n- Action: Streamer is holding and playing with a game controller.`;
      }
  }

  return `
Generate ${hasRef ? "an" : "a photorealistic"} image of a live streamer. 

${hasRef ? `
CRITICAL REFERENCE ADHERENCE:
1. **CHARACTER**: Strictly follow the facial features, hair, skin tone, and clothing style of the provided reference image. The generated character must look exactly like the reference. However camera angle should follow the 'TECHNICAL SPECS' stated below.
2. **STYLE**: Adopt the art style (e.g. 3D render, anime, oil painting, photo) of the reference image for the entire composition, including the background.
3. **OVERRIDES**: Only deviate from the reference image if the "Appearance" or "Setting" descriptions below explicitly request a specific change (e.g. "change hair to blue", "pixel art style").
` : `
TECHNICAL SPECS:
- Render Style: Photo-realistic, ultra details, high res with livestream quality lighting effect.
`}

TECHNICAL SPECS (CAMERA):
- Perspective: Wide-angle, direct frontal, slight overhead, shot. Looking down slightly at the streamer.
- Framing: Close-up. Head and top of shoulders only.
- Gaze: Streamer is looking slightly DOWN (at the monitor/phone), NOT directly into the lens.

SUBJECT:
- Appearance: ${config.appearance}
- Setting: ${config.setting} (Background must be out of focus/depth of field).${deviceInstruction}

NEGATIVE PROMPT (DO NOT INCLUDE):
- Text, overlays, UI, HUDs, watermarks, microphones covering the face, headphones covering the eyes.
`;
};

// --- VEO SCRIPT ANALYSIS ---
export const constructVeoAnalysisPrompt = (script: string): string => {
    return `
You are a video production assistant. Analyze the following streamer script and convert it into a structured list of video segments for Veo generation.

SCRIPT TO ANALYZE:
---
${script}
---

OUTPUT REQUIREMENTS:
Return a valid JSON array (no markdown, no code fences, raw JSON only) where each element represents one segment with these exact fields:
- "id": sequential integer starting at 1
- "startTime": timestamp string "MM:SS" (e.g. "00:00")
- "endTime": timestamp string "MM:SS" for when this segment ends
- "duration": integer, MUST be exactly 4, 6, or 8 (choose the value closest to the actual segment length)
- "prompt": a detailed visual description of the streamer's physical actions and expressions (NO game/screen references — pure human body language and facial expressions)
- "dialogue": the exact spoken words for this segment (empty string "" if silent)

CRITICAL RULES:
1. Every segment duration must be 4, 6, or 8 — no other values allowed.
2. The "prompt" must describe ONLY the streamer's physical appearance (facial expressions, body language, gestures). NEVER mention what is on-screen or in the game.
3. Use the STREAMER_RULES from the original script to infer expressions if not explicit.
4. Total durations should sum to match the full script length.
5. Output ONLY the raw JSON array. No explanations, no markdown.

Example output format:
[{"id":1,"startTime":"00:00","endTime":"00:06","duration":6,"prompt":"Streamer leans forward, eyes wide open, jaw slightly dropped in surprise, gripping the controller tightly with both hands.","dialogue":"Oh no way, this is insane!"},{"id":2,"startTime":"00:06","endTime":"00:10","duration":4,"prompt":"Streamer grins broadly, eyebrows raised, nodding head slowly with excitement.","dialogue":"Let's go!"}]
`;
};

// --- VEO GENERATION (VIDEO CLIPS) ---
export const constructVeoGenerationPrompt = (
    visualPrompt: string,
    dialogue: string,
    durationSeconds: number
): string => {
    const hasDialogue = dialogue && dialogue.trim().length > 0;
    
    // Audio instruction
    // Veo 3.1 can interpret bracketed instructions in the dialogue string itself.
    const audioPrompt = hasDialogue 
        ? `Streamer says: "${dialogue}". Lip sync matches speech.`
        : `Streamer is silent. Mouth closed.`;

    return `
    IMAGE-TO-VIDEO GENERATION.

    STRICT TECHNICAL CONSTRAINTS (MUST FOLLOW):
    1. CAMERA: **TRIPOD SHOT**. LOCKED OFF. ABSOLUTELY NO CAMERA MOVEMENT. NO ZOOM. NO PAN.
    2. SHOT CONTINUITY: Single continuous take. No cuts.
    3. STREAMER GAZE: Eyes stay focused on the monitor/mobile phone (below camera).
    4. OVERLAYS: No text, no subtitles, no UI.
    5. AUDIO: ${hasDialogue ? 'Speech only.' : 'Silence.'} NO MUSIC. NO SFX.
    6. DURATION: Exactly ${durationSeconds} seconds.
    7. NEGATIVE PROMPT: No gameplay footage. No video game UI. No HUD. No CGI characters next to streamer. No music. No SFX. No camera movements. No scene cuts. No graphics or animations.
    8. [IF APPLICABLE] GAMING PHONE STABILITY: STREAMER DOES NOT ROTATE THE PHONE THAT THEY ARE HOLDING. DEVICE ORIENTATION IS FIXED AT ALL TIMES

    SUBJECT:
    Gaming Streamer. ${visualPrompt}
    
    DIALOGUE:
    ${audioPrompt}
 
    `;
};
