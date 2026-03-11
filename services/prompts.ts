
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
3. **SEGMENTATION**: Break the script into chunks of exactly **4s, 6s, or 8s**.
4. **WORD COUNT LIMITS** (Strict Pacing):
   - **4s Segment**: LESS THAN 15 words. (Short reactions only).
   - **6s Segment**: LESS THAN 20 words.
   - **8s Segment**: LESS THAN 25 words.
5. **TIMESTAMPS**: You must calculate the cumulative timestamp for each segment.

VISUAL DESCRIPTION RULES (CRITICAL FOR VEO):
1. **STREAMER ACTION**: Must be EXTREMELY DETAILED (Micro-Expression Level).
   - Describe specific facial features: "Eyes wide open," "Jaw dropped," "Bit lip," "Eyebrows furrowed."
   - Describe body language: "Leans forward aggressively," "Throws head back," "Covers mouth."
   
2. **DEVICE INTERACTION (CRITICAL)**:
   - You MUST adhere to the [Gaming Device] selected by the user.
   - **Mobile (Vertical)**: Start action with "Phone held vertically at all times." Streamer holds phone VERTICALLY (Portrait) with both hands. Thumbs tapping/swiping.
   - **Mobile (Horizontal)**: Start action with "Phone held horizontally at all times." Streamer holds phone HORIZONTALLY (Landscape) with both hands. Thumbs tapping.
   - **PC**: Streamer uses Keyboard and Mouse on desk.
   - **Console**: Streamer holds a standard Gamepad/Controller.
   - **NEVER** mix these up. If the user selected "PC", do NOT mention a phone or controller.

3. **PURE HUMAN ACTION (NO GAME ELEMENTS)**: 
   - The [Streamer Action] description must be 100% about the human. 
   - **NEVER** mention what is on the screen (e.g. DO NOT say "Reacts to explosion", "Looking at the dragon"). 
   - Instead use physical descriptions: "Reacts with shock", "Staring intensely at screen", "Wincing in pain".

DIALOGUE & AUDIO RULES:
1. **VOCAL EFFECTS**: If the user's "Additional Instructions" request a specific tone (e.g. ASMR, Whispering, Shouting, Crying, Sarcastic), you MUST prefix the dialogue with it in brackets.
   - Example: Streamer Dialogue: "[ASMR whisper] Guys, look at this texture..."
   - Example: Streamer Dialogue: "[Shouting loudly] No way! No way!"
   - This allows the video generation model to produce the correct audio style.

FORMATTING RULES:
1. Refer to the character as 'Streamer'.
2. Follow the STRICT_TEMPLATE below exactly for every segment.
3. **Add a blank line between each scene.**

NEGATIVE CONSTRAINTS (DO NOT INCLUDE):
1. DO NOT describe the streamer turning the phone/screen towards the camera/viewers.
2. DO NOT mention music, singing, or dancing.
3. DO NOT describe actions associated with music (e.g. "nodding head to beat").
`;

const STRICT_TEMPLATE = `
STRICT OUTPUT TEMPLATE:
Do not include any conversational filler. Output ONLY the script following this format.

# SCRIPT METADATA
**Game:** [Game Name]
**Device:** [Device Type]
**Total Duration:** [Total Seconds]s

# TIMELINE
[00:00]
[Duration: 6s]
[Visual: Describe specific gameplay event happening on screen]
[Streamer Action: Phone held [orientation] at all times. Leaning forward, eyes squinting at monitor/phone, hands gripping [Device] tightly]
[Streamer Dialogue: "What is up guys! We are checking out [Game] today..."]

[00:06]
[Duration: 4s]
[Visual: Character jumps over a gap]
[Streamer Action: Phone held [orientation] at all times. Eyes darting rapidy, sudden head jerk back, fingers tapping [Device] furiously]
[Streamer Dialogue: (No Dialogue)]

[00:10]
[Duration: 8s]
[Visual: Character dies to a glitch]
[Streamer Action: Phone held [orientation] at all times. Throws head back laughing, covering eyes with one hand, other hand lets go of [Device]]
[Streamer Dialogue: "Did you see that physics glitch? No way!"]

... (Continue until Total Duration is reached) ...

`;

// --- SCRIPT GENERATION ---
export const constructGeneratorPrompt = (info: GameInfo): string => `
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
   - If **Mobile (Vertical)**: EVERY [Streamer Action] MUST START WITH: "Phone held vertically at all times." followed by the action.
   - If **Mobile (Horizontal)**: EVERY [Streamer Action] MUST START WITH: "Phone held horizontally at all times." followed by the action.
   - If **PC**: Ensure descriptions involve keyboard/mouse interaction.
   - If **Console**: Ensure descriptions involve a controller.
2. **RESEARCH**: Use the **Game URL** to identify unique features, mechanics, or selling points of the game. Incorporate these specific details into the [Streamer Dialogue] to make the commentary authentic and knowledgeable.
3. If 'User Instructions' imply a specific voice style (ASMR, Screaming, etc), apply it to the [Streamer Dialogue] in brackets.

${STREAMER_RULES}

${STRICT_TEMPLATE}
`;


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

// --- VEO ANALYSIS (SHOT PLANNING) ---
export const constructVeoAnalysisPrompt = (script: string): string => `
You are a Technical Director for AI Video generation.

TASK:
Convert the provided script into a JSON array of video segments.
You are NOT writing new content. You are extracting data.

CRITICAL RULES:
1. **DURATION**: Extract the integer from the [Duration: Xs] tag. (Must be 4, 6, or 8).
2. **PROMPT (Streamer Action)**: 
   - Extract the content from the **[Streamer Action]** line.
   - **IGNORE** the [Visual] line (which describes the game).
   - **SANITIZE**: Remove ANY references to game objects, enemies, or in-game events. 
   - The prompt must ONLY describe the human (face, body, hands) and the device (phone/controller/keyboard).
   - BAD: "Looking at the dragon flying by."
   - GOOD: "Looking up at the screen with mouth open."
3. **DIALOGUE**: 
   - Extract the content from the **[Streamer Dialogue]** line.
   - If it says "(No Dialogue)" or is empty, return empty string.
   - **KEEP** any bracketed vocal instructions like [ASMR] or [Shouting] as part of the dialogue string.

SCRIPT:
${script}

OUTPUT FORMAT:
Return ONLY a raw JSON array.
`;

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
    
    SUBJECT:
    Gaming Streamer. ${visualPrompt}
    
    DIALOGUE:
    ${audioPrompt}
    
    STYLE & QUALITY:
    - Photorealistic, 4k, high fidelity.
    - Shallow depth of field (background blurred).
    
    STRICT TECHNICAL CONSTRAINTS (MUST FOLLOW):
    1. CAMERA: **TRIPOD SHOT**. LOCKED OFF. ABSOLUTELY NO CAMERA MOVEMENT. NO ZOOM. NO PAN.
    2. CONTINUITY: Single continuous take. No cuts.
    3. STREAMER GAZE: Eyes stay focused on the monitor/mobile phone (below camera).
    4. OVERLAYS: No text, no subtitles, no UI.
    5. AUDIO: ${hasDialogue ? 'Speech only.' : 'Silence.'} NO MUSIC. NO SFX.
    6. DURATION: Exactly ${durationSeconds} seconds.
    7. NEGATIVE PROMPT: No gameplay footage. No video game UI. No HUD. No CGI characters next to streamer. No music. No SFX. No camera movements. No scene cuts. No graphics or animations.
    7. [IF APPLICABLE] GAMING PHONE STABILITY: STREAMER DOES NOT ROTATE THE PHONE THAT THEY ARE HOLDING. DEVICE ORIENTATION IS FIXED AT ALL TIMES
    `;
};
