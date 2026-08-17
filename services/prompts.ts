import { GameInfo, AvatarConfig } from "../types";

// --- SHARED CONSTANTS ---
const BASE_PERSONA = `
You are a top-tier, high-energy gaming livestreamer (Streamer).
You speak naturally, use gamer slang appropriately (but not cringey), and know how to retain viewers.
Your vibe is professional yet hype. You are NOT a generic AI assistant.

CRITICAL PRONOUN RULE: Always use gender-neutral pronouns ('they' or 'them') when referring to the streamer in all descriptions and prompts. Do not use 'he', 'she', 'him', 'his', or 'her'.
`;

const getStreamerRules = () => {
    return `
CRITICAL DURATION & TIMELINE RULES:
1. **TOTAL DURATION**: The sum of all segment durations MUST EXACTLY EQUATE to the length of the uploaded gameplay video.
2. **SEGMENTATION**: Break the script into consecutive, natural scene beats of **3 to 10 seconds** each.
3. **STRICT SPOKEN WORD COUNT MATCHING SEGMENT DURATION**:
   - Streamer dialogue must be realistically paced so that the streamer speaks naturally across the full duration of the shot without cutting off or being silent.
   - You MUST adhere to these exact word targets based on each segment's duration:
     * 3-second segment: 4 to 5 spoken words.
     * 4-second segment: 5 to 7 spoken words.
     * 5-second segment: 7 to 10 spoken words.
     * 6-second segment: 10 to 13 spoken words.
     * 7-second segment: 13 to 16 spoken words.
     * 8-second segment: 16 to 19 spoken words.
     * 9-second segment: 19 to 22 spoken words.
     * 10-second segment: 22 to 25 spoken words.
   - CRITICAL NEGATIVE CONSTRAINT: DO NOT output 1-word or 2-word dialogue (e.g. "Nice!", "Let's go") for long 6-10 second clips! If a clip is 9 seconds long, the streamer MUST speak 19 to 22 words of full, continuous commentary sentences.
   - EXCLUDE VOCAL FX BRACKETS FROM WORD COUNT: Bracketed direction tags like "[Laughing]", "[Sharp gasp]", "[ASMR whisper]", "[Shouting excitedly]" are voice synthesis directives and are excluded from the spoken word count.
4. **TIMESTAMPS**: Calculate cumulative timestamps for each segment (e.g. "00:00", "00:06", "00:13").

VISUAL DESCRIPTION RULES (STREAMER ACTIONS & MICRO-EXPRESSIONS):
1. **STREAMER ACTION**: Must be EXTREMELY DETAILED (Micro-Expression Level).
   - Describe specific facial features: "Eyes wide open," "Jaw dropped," "Bit lip," "Eyebrows furrowed," "Grins broadly."
   - Describe body language: "Leans forward aggressively," "Throws head back in laughter," "Covers mouth in shock."

2. **PURE HUMAN ACTION (NO GAME/SCREEN ELEMENTS)**:
   - The streamer action description must be 100% about the human.
   - **NEVER** mention what is on the screen (e.g. DO NOT say "Reacts to explosion", "Looking at the dragon").
   - Instead use physical descriptions: "Reacts with shock", "Staring intensely ahead", "Wincing in pain".

DIALOGUE & AUDIO RULES:
1. **VOCAL FX (VFX)**: You MUST prefix dialogue with expressive vocal cues in brackets when appropriate:
   - Examples: "[Laughing] No way, they actually pulled that off!", "[Sharp gasp] Look at that health bar!", "[Shouting excitedly] Let's go!", "[ASMR whisper] Watch this sneak attack..."
   - This directs the AI model's native voice synthesis engine.

FORMATTING RULES:
1. Refer to the character as 'Streamer'. Use gender-neutral pronouns ('they'/'them') when referring to the streamer. Do not use 'he' or 'she'.

NEGATIVE CONSTRAINTS:
1. DO NOT describe the streamer turning the phone/screen towards camera.
2. DO NOT mention background music or non-vocal SFX.
3. Camera perspective remains completely static (locked tripod shot).
`;
};

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
    } else if (info.gamingDevice === 'Hands-free (No device)') {
        deviceInstruction = `Ensure descriptions do NOT involve any interactions with devices (no phones, no controllers, no keyboards). Streamer is completely hands-free.`;
    }

    const groundingInstruction = info.searchGrounding && info.url
        ? `3. **GOOGLE SEARCH GROUNDING ACTIVE**: You have Google Search grounding enabled for the official Game URL: "${info.url}". Use the Google Search tool to look up details, features, launch dates, unique mechanics, platforms, pricing, or target audience for "${info.title}". You have the context and liberty to incorporate these researched facts to promote the game and sound like an authentic fan/expert, aligning your promotion naturally with the gameplay visuals.`
        : `3. **NO SEARCH GROUNDING**: Do NOT use Google Search grounding. Restrict the streamer's commentary strictly to what is directly visible in the gameplay footage. Do not make up features or facts about the game that are not visible.`;

    const videoInstruction = info.videoFile
        ? `4. **VIDEO SYNCHRONIZATION**: You have been provided with the gameplay video file. You MUST analyze the video to identify key events, actions, milestones, combat status, victories, or failures occurring at each timestamp. Your commentary [Streamer Dialogue] and physical reactions [Streamer Action] MUST synchronize directly and logically with these specific gameplay visuals in the video.`
        : '';

    const titleInstruction = `5. **GAME TITLE INTRO**: The streamer should naturally mention the Game Title ("${info.title}") in the first shot/segment of the script to introduce the game at timestamp 00:00.`;
    const ctaInstruction = `6. **CALL TO ACTION (CTA) PLACEMENT**: The streamer **MUST** naturally deliver the Call to Action ("${info.cta}") in the final shot/segment of the script as the closing remark.`;
    const userInstructionRule = info.additionalInstructions
        ? `7. **USER INSTRUCTIONS ADHERENCE**: You must strictly follow and incorporate the specific instructions regarding the streamer's tone, messaging, gaming style, persona, or any specific features/actions mentioned in the User Instructions: "${info.additionalInstructions}".`
        : '';

    return `
${BASE_PERSONA}

TASK: Create a synchronized gameplay commentary script using Gemini 3.6 Flash.

PROJECT CONTEXT:
- Game: "${info.title}"
- CTA: "${info.cta}"
- User Instructions (Style/Tone/Messaging/Streamer Persona/Additional notes): "${info.additionalInstructions}"
- **Gaming Device (Selected by User)**: "${info.gamingDevice}"

CRITICAL INSTRUCTION:
1. **DEVICE AUTHENTICITY**: The user has explicitly selected **${info.gamingDevice}** as the platform.
   - ${deviceInstruction}
2. Apply expressive vocal effects in brackets ([Laughing], [Shouting], [ASMR whisper], [Gasping]) to [Streamer Dialogue].
${groundingInstruction}
${videoInstruction}
${titleInstruction}
${ctaInstruction}
${userInstructionRule}

${getStreamerRules()}
`;
};

// --- AVATAR GENERATION ---
export const constructAvatarPrompt = (config: AvatarConfig): string => {
    const hasRef = !!config.referenceImage;

    let deviceInstruction = '';
    let gazeInstruction = `- Gaze: Streamer is looking slightly DOWN (at the monitor/phone), NOT directly into the lens.`;
    let negativeExtra = '';

    if (config.gamingDevice) {
        if (config.gamingDevice === 'Mobile (Vertical)') {
            deviceInstruction = `\n- Action: Streamer is holding and playing a mobile phone vertically (portrait mode). Only back of phone is visible`;
            negativeExtra = 'No gamepads, no game controllers, no keyboards, no mouse.';
        } else if (config.gamingDevice === 'Mobile (Horizontal)') {
            deviceInstruction = `\n- Action: Streamer is holding and playing a mobile phone horizontally (landscape mode). Only back of phone is visible`;
            negativeExtra = 'No gamepads, no game controllers, no keyboards, no mouse.';
        } else if (config.gamingDevice === 'PC') {
            deviceInstruction = `\n- Setting: Streamer is at a gaming desk setup with keyboard and mouse visible in foreground.`;
            negativeExtra = 'No handheld game controllers, no mobile phones, no gamepads.';
        } else if (config.gamingDevice === 'Console') {
            deviceInstruction = `\n- Action: Streamer is holding a gaming controller / gamepad with both hands.`;
            negativeExtra = 'No mobile phones, no keyboards, no mouse.';
        } else if (config.gamingDevice === 'Hands-free (No device)') {
            deviceInstruction = `\n- Setting: Streamer is sitting in their streaming room, hands completely empty and free.`;
            gazeInstruction = `- Gaze: Streamer looks DIRECTLY into the camera lens with engaging eye contact.`;
            negativeExtra = 'No controllers, no keyboards, no mouse, no desk blocking view, no phones.';
        }
    }

    if (hasRef) {
        return `
Professional gaming livestreamer avatar portrait.
Photorealistic, cinematic lighting, eye-level framing, medium shot.
Maintain consistent identity and facial features with the reference image.
- Appearance: ${config.appearance || 'Consistent with reference persona'}
- Background: ${config.setting || 'Professional streaming room with warm accent lighting'}
${gazeInstruction}
${deviceInstruction}
High detail, sharp focus, vibrant aesthetic.
Negative Prompt: Blurry, distorted, low quality, CGI game graphics, animated overlays, cartoonish. ${negativeExtra}
`;
    }

    return `
Professional gaming livestreamer avatar portrait.
Photorealistic, cinematic lighting, eye-level framing, medium shot.
- Appearance: ${config.appearance || 'Energetic young adult gamer in modern gaming attire'}
- Background: ${config.setting || 'Modern streaming room with RGB accent glow and gaming gear'}
${gazeInstruction}
${deviceInstruction}
High detail, sharp focus, vibrant aesthetic.
Negative Prompt: Blurry, distorted, low quality, CGI game graphics, animated overlays, cartoonish. ${negativeExtra}
`;
};

// --- GEMINI OMNI FLASH VIDEO GENERATION ---
export const constructOmniGenerationPrompt = (
    visualPrompt: string,
    dialogue: string,
    durationSeconds: number,
    gamingDevice?: string,
    hasPreviousPose?: boolean
): string => {
    let deviceInstruction = 'Streamer is seated at a gaming setup.';
    let gazeInstruction = 'Streamer looks naturally at the screen / desk.';

    if (gamingDevice === 'Hands-free (No device)') {
        deviceInstruction = 'Streamer is completely hands-free with empty hands.';
        gazeInstruction = 'Streamer looks directly into the camera lens with engaging eye contact.';
    } else if (gamingDevice === 'PC') {
        deviceInstruction = 'Streamer plays on PC with keyboard and mouse on desk.';
    } else if (gamingDevice === 'Console') {
        deviceInstruction = 'Streamer holds a gamepad controller in hands.';
    } else if (gamingDevice === 'Mobile (Vertical)') {
        deviceInstruction = 'Streamer holds a smartphone vertically in portrait mode.';
    } else if (gamingDevice === 'Mobile (Horizontal)') {
        deviceInstruction = 'Streamer holds a smartphone horizontally in landscape mode.';
    }

    const hasDialogue = dialogue && dialogue.trim().length > 0;
    const cleanDialogue = dialogue ? dialogue.replace(/[\r\n]+/g, ' ').trim() : '';

    return `<Image0> is the starting frame. In a single continuous shot with static camera:
The livestreamer performs: ${visualPrompt}
${deviceInstruction} ${gazeInstruction}
${hasDialogue ? `Streamer dialogue: "${cleanDialogue}". Natural speaking motion and lip synchronization.` : `Streamer remains silent.`}
Duration: ${durationSeconds} seconds.
Audio guidelines: Streamer spoken voice and vocal reactions only. No background music. No game sound effects. No scene cuts. No camera movement.`;
};

// Backwards compatibility alias
export const constructVeoGenerationPrompt = (
    visualPrompt: string,
    dialogue: string,
    durationSeconds: number,
    gamingDevice?: string
): string => {
    return constructOmniGenerationPrompt(visualPrompt, dialogue, durationSeconds, gamingDevice, false);
};

export const constructVeoAnalysisPrompt = (gameTitle?: string): string => {
    return `Analyze this gameplay video for Gemini 3.6 Flash commentary. ${gameTitle ? `Game: ${gameTitle}.` : ''} Identify key events, timestamps, combat, actions, and milestones.`;
};
