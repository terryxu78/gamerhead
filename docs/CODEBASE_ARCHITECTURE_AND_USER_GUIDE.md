# GamerHeads: Comprehensive Codebase & Architecture Guide

> **Version:** 1.5  
> **Target Platform:** Google Cloud Platform (Cloud Run, Vertex AI, Google Cloud Storage, Firestore / Datastore)  
> **Core AI Stack:** Gemini 3.5 Flash, Gemini 3.1 Flash Image, Veo 3.1 Standard & Veo 3.1 Fast  
> **Last Updated:** August 2026

---

## Table of Contents

1. [Executive Overview & Vision](#1-executive-overview--vision)
2. [High-Level Architecture & Tech Stack](#2-high-level-architecture--tech-stack)
3. [End-to-End User Flow & Journey](#3-end-to-end-user-flow--journey)
4. [Component & Functional Deep Dive](#4-component--functional-deep-dive)
   - [4.1 Authentication & User Session Management](#41-authentication--user-session-management)
   - [4.2 Project Configuration & Layout Engine](#42-project-configuration--layout-engine)
   - [4.3 Avatar Lab & Character Synthesis](#43-avatar-lab--character-synthesis)
   - [4.4 Script Generation & Multimodal Video Analysis](#44-script-generation--multimodal-video-analysis)
   - [4.5 Production Studio & Sequential Veo Generation](#45-production-studio--sequential-veo-generation)
   - [4.6 Client-Side Compositing & Audio Mixing](#46-client-side-compositing--audio-mixing)
   - [4.7 Server-Side Stitching & Adaptive Subtitle Burn-in](#47-server-side-stitching--adaptive-subtitle-burn-in)
   - [4.8 Administrator Analytics Dashboard](#48-administrator-analytics-dashboard)
5. [Backend API Reference (`server.js`)](#5-backend-api-reference-serverjs)
6. [Prompt Engineering Architecture (`services/prompts.ts`)](#6-prompt-engineering-architecture-servicespromptsts)
7. [Media Processing Pipeline](#7-media-processing-pipeline)
8. [Data Models & TypeScript Interfaces (`types.ts`)](#8-data-models--typescript-interfaces-typests)
9. [Deployment & Infrastructure (`deploy.sh`, `Dockerfile`)](#9-deployment--infrastructure-deploysh-dockerfile)
10. [Directory Structure & File Inventory](#10-directory-structure--file-inventory)

---

## 1. Executive Overview & Vision

**GamerHeads** is an enterprise-grade AI web application that automatically creates engaging, high-energy gaming livestreamer reaction videos overlaid onto raw gameplay footage. 

Gaming marketing assets and user-acquisition videos with human streamer reactions consistently outperform static or pure gameplay footage in click-through rates (CTR) and retention. However, hiring real streamers, writing synchronized reaction scripts, recording green-screen footage, and editing picture-in-picture (PiP) composites is time-consuming and expensive. 

GamerHeads automates the entire production pipeline:
1. **Analyzes raw gameplay video** using Gemini multimodal vision.
2. **Researches game details & unique selling points** using Google Search Grounding.
3. **Generates an expressive streamer persona** using `gemini-3.1-flash-image` or custom reference images.
4. **Drafts timed dialogue and micro-expression prompts** calibrated to 4s/6s/8s pacing blocks.
5. **Generates realistic, synchronized video clips** using Google Veo 3.1 image-to-video models with sequential continuity.
6. **Composites the final video** in PiP, stacked split-screen, or streamer-only formats with audio balancing and burned-in subtitles.
7. **Monitors and tracks usage** across team members with built-in telemetry and an admin analytics dashboard.

---

## 2. High-Level Architecture & Tech Stack

```
+---------------------------------------------------------------------------------------------+
|                                      CLIENT BROWSER (SPA)                                   |
|                                                                                             |
|   +-------------------+   +--------------------+   +-------------------+   +------------+   |
|   |   ProjectForm     |   |  AvatarGenerator   |   |      Studio       |   | AdminDash  |   |
|   | (Aspect & Layout) |   | (Image Synthesis)  |   | (Clip Production) |   | (Analytics)|   |
|   +-------------------+   +--------------------+   +-------------------+   +------------+   |
|             |                       |                        |                   |          |
|             v                       v                        v                   v          |
|   +-------------------------------------------------------------------------------------+   |
|   |      Frontend Services (`auth.ts`, `gemini.ts`, `logging.ts`, `subtitles.ts`)        |   |
|   |         - Google Identity Services (GIS OAuth2 + Silent Refresh)                     |   |
|   |         - Client Canvas Compositor (`videoUtils.ts`) & Web Audio API Gain Nodes      |   |
|   +-------------------------------------------------------------------------------------+   |
+---------------------------------------------------|-----------------------------------------+
                                                    | Authenticated HTTPS Requests
                                                    | (Bearer Token / Basic Auth)
                                                    v
+---------------------------------------------------------------------------------------------+
|                                EXPRESS NODE.JS BACKEND (Cloud Run)                          |
|                                                                                             |
|   - Request Logger & Rate Limiter / Compression                                             |
|   - Google Token Verification (`google-auth-library` OAuth2Client)                           |
|   - Server Proxy for Vertex AI & Veo (Zero API Keys Exposed to Browser)                     |
|   - Server-Side FFmpeg Stitcher & Libass Adaptive Subtitle Renderer                          |
|   - Signed GCS URL Generator for Private Bucket Downloads                                   |
+-------------------+--------------------+--------------------+-------------------------------+
                    |                    |                    |
                    v                    v                    v
+-----------------------+ +----------------------+ +--------------------+ +-------------------+
|  Vertex AI (Gemini)   | |  Vertex AI (Veo 3.1) | | Google Cloud GCS   | | Google Datastore  |
|  - gemini-3.5-flash   | |  - veo-3.1-generate  | |  - Private Bucket  | |  - GenerationLog  |
|  - gemini-3.1-flash-img| |  - veo-3.1-fast      | |  - Video Objects   | |    Kind Analytics |
+-----------------------+ +----------------------+ +--------------------+ +-------------------+
```

### Core Technologies
- **Frontend:** React 19, TypeScript 5.8, Vite 6.2, Tailwind CSS, Recharts 2.12.
- **Backend:** Express 4.18 (ES Modules), Node.js 20 LTS, Multer, Compression.
- **AI Models & Frameworks:** `@google/genai` (Node.js SDK) calling Google Cloud Vertex AI via Application Default Credentials (ADC).
- **Video & Graphics Processing:**
  - Client: HTML5 `<canvas>`, MediaStream Capture API, Web Audio API (`AudioContext`, `GainNode`), `MediaRecorder`.
  - Server: FFmpeg & FFprobe (system binary via `child_process.execFileAsync`), Advanced SubStation Alpha (ASS) subtitle rendering.
- **Persistence & Cloud Storage:** `@google-cloud/datastore` (Firestore in Datastore mode), `@google-cloud/storage` (Google Cloud Storage).

---

## 3. End-to-End User Flow & Journey

The user experience is divided into a structured, step-by-step production funnel:

```
[ Step 0: Auth ] ────► [ Step 1: Project Details ] ────► [ Step 2: Avatar Lab ] ────► [ Step 3: Production Studio ] ────► [ Step 4: Export ]
 (Google Sign-In)       - Format: 16:9 vs 9:16            - Reference Image Upload      - Script & Shot Generation         - Audio Volume Balance
                        - Layout: PiP / Stacked / Only    - AI Avatar Generation        - Veo Clip Production (1-by-1)     - Subtitle Burn-in
                        - Device, Title, URL, Video       - Aspect Ratio Auto-Crop      - Continuity Frame Linking         - Lossless MP4 Download
```

### Stage Breakdown:

1. **Authentication (Optional / Configurable):**
   - User signs in with Google OAuth (via Google Identity Services).
   - If `AUTHORIZED_USERS` or `AUTHORIZED_DOMAIN` is configured on the backend, only whitelisted accounts gain access.
2. **Project Setup (`ProjectForm`):**
   - **Step 1:** Select target canvas format (`16:9` YouTube Horizontal vs `9:16` YouTube Shorts / TikTok).
   - **Step 2:** Select layout style (`Classic PiP`, `Stacked Split-Screen`, or `Streamer Only`) and placement (`bottom-left`, `top`, `left`, etc.).
   - **Step 3:** Enter Game Title, optional Google Search Grounding URL, Call to Action (CTA), Gaming Device type (`PC`, `Console`, `Mobile Vertical`, `Mobile Horizontal`, `Hands-free`), Dialogue Packing speed (`Slow`, `Normal`, `Fast`), additional persona instructions, and upload gameplay footage (`.mp4`/`.mov` up to 250MB).
3. **Avatar Creation (`AvatarGenerator`):**
   - User either uploads an existing character reference photo or describes streamer appearance and gaming room background.
   - If using a reference image with an aspect ratio mismatch, an in-app modal offers one-click intelligent center-cropping.
   - Clicking "Generate Avatar" triggers `gemini-3.1-flash-image` to synthesize a photorealistic streamer avatar.
4. **Script & Shot List Generation:**
   - Client optimizes/compresses uploaded gameplay footage (down to 720p/540p < 20MB) using client-side canvas.
   - `gemini-3.5-flash` analyzes video visual milestones, executes Google Search grounding (if enabled), and outputs a structured JSON shot list broken into 4s, 6s, or 8s blocks with dialogue word counts strictly matched to the chosen packing speed.
5. **Video Clip Production (`Studio`):**
   - User reviews each shot's dialogue and visual micro-expression prompts.
   - User chooses Veo model (`Veo 3.1 Standard` vs `Veo 3.1 Fast`) and generation mode (`Single Clip` vs `2 Options in Parallel`).
   - **Sequential Visual Continuity:** Shot 1 starts from the generated Avatar image. Subsequent shots can either maintain visual continuity by extracting the last frame from the previous video clip or use the original avatar as a keyframe reset.
   - Generates video clips asynchronously through Vertex AI Veo image-to-video API.
6. **Review, Composite & Export:**
   - User previews the stitched sequence in an integrated player.
   - Adjusts the audio balance slider (Streamer Voice vs Gameplay SFX).
   - Toggles optional subtitle burn-in.
   - Clicks "Download Final Mix" (browser renders canvas composite with Web Audio mix, then server burns ASS subtitles) or "Download Streamer Only" (server lossless concat).

---

## 4. Component & Functional Deep Dive

### 4.1 Authentication & User Session Management
- **Files:** `services/auth.ts`, `server.js` (lines 65-218)
- **Mechanism:**
  - Token is stored in `sessionStorage` under `gh_id_token`, ensuring credentials automatically clear when the browser tab closes.
  - `apiFetch` wraps all HTTP calls. If any backend endpoint returns a `401 Unauthorized`, `refreshToken()` triggers Google One Tap silently in the background to acquire a fresh ID token and transparently retries the failed request.
  - Backend verifies tokens cryptographically using `OAuth2Client.verifyIdToken()` from `google-auth-library`.
  - Also supports HTTP Basic Auth (`BASIC_AUTH_USERS`) for environments where Google OAuth is unavailable.

### 4.2 Project Configuration & Layout Engine
- **Files:** `components/ProjectForm.tsx`, `types.ts`
- **Supported Layouts:**
  - `classic-pip`: Streamer occupies 10% of total screen area, bordered with a white frame and drop shadow in any of the 4 corners (`top-left`, `top-right`, `bottom-left`, `bottom-right`).
  - `stacked`: Split-screen presentation. In `9:16`, streamer occupies 35% height (top or bottom) with gameplay filling remaining 65%. In `16:9`, streamer occupies 30% width (left or right) with gameplay filling remaining 70%.
  - `streamer-only`: Pure streamer reaction without background gameplay.
- **Dynamic Invalidation Logic:**
  - If a user changes layout or aspect ratio in `ProjectForm` after generating an avatar or video clips, `App.tsx` detects the mismatch, alerts the user, invalidates the previous avatar aspect ratio, and resets downstream video clips to prevent rendering distortion.

### 4.3 Avatar Lab & Character Synthesis
- **Files:** `components/AvatarGenerator.tsx`, `services/gemini.ts`
- **Model:** `gemini-3.1-flash-image` (Vertex AI Global Endpoint).
- **Features:**
  - Reference image upload with client-side canvas aspect ratio verification (`checkImageRatio`, `cropImageToRatio`).
  - Option to bypass AI generation and directly use cropped reference photos as the streamer avatar.
  - Automatic prompt injection for streamer gaze (looking slightly down at device vs directly into camera for hands-free).
  - Safety thresholds set to `BLOCK_NONE` to prevent false-positive blocks on gaming avatar artwork.

### 4.4 Script Generation & Multimodal Video Analysis
- **Files:** `services/gemini.ts`, `services/prompts.ts`
- **Model:** `gemini-3.5-flash` with structured JSON schema (`responseSchema`).
- **Features:**
  - **Video Pre-Processing:** Compresses video client-side (`compressVideo` in `videoUtils.ts`) to stay strictly within 20MB payload limits.
  - **Grounding Integration:** If Search Grounding is enabled, passes `tools: [{ googleSearch: {} }]` so Gemini queries Google Search to discover real gameplay mechanics, character names, release dates, and store offers.
  - **Word Count & Duration Enforcement:** Breaks script into chunks of exactly 4s, 6s, or 8s matching the duration of the uploaded video.

### 4.5 Production Studio & Sequential Veo Generation
- **Files:** `components/Studio.tsx`, `services/gemini.ts`
- **Models:** `veo-3.1-generate-001` (Standard) and `veo-3.1-fast-generate-001` (Fast).
- **Key Capabilities:**
  - **Frame Continuity Engine:** `extractLastFrame(videoUrl)` decodes the exact last frame of the previous clip via HTML5 Canvas and feeds it into Veo as the starting image for the next shot.
  - **2-Option Parallel Generation:** Generates two alternative clips simultaneously so the user can select their preferred facial reaction.
  - **Stale Continuity Warning:** Displays an alert if an earlier clip was regenerated, indicating that subsequent clips should be refreshed.
  - **Cancellation Control:** AbortController cancels in-flight polling if the user halts generation or regenerates.

### 4.6 Client-Side Compositing & Audio Mixing
- **Files:** `utils/videoUtils.ts`
- **Mechanism:**
  - Uses an off-screen HTML5 Canvas (1920x1080 or 1080x1920 base resolution).
  - Renders gameplay in background with "Cover" crop mode.
  - Renders streamer PiP with 20px rounded corners, white borders, and drop shadow.
  - Mixes audio using Web Audio API: connects gameplay video and streamer video to separate `GainNode` instances, combines them into a `MediaStreamDestination`, and records via `MediaRecorder` at 10 Mbps.

### 4.7 Server-Side Stitching & Adaptive Subtitle Burn-in
- **Files:** `server.js` (lines 883-1118), `utils/subtitles.ts`
- **Mechanism:**
  - Server receives video blobs via Multer and writes them to temporary directories (`os.tmpdir()`).
  - Concatenates clips using FFmpeg concat demuxer (`-f concat -safe 0 -c copy`).
  - **Adaptive ASS Subtitle System:** `buildAssFromSrt` generates Advanced SubStation Alpha format where `PlayResX` and `PlayResY` match the exact probed video dimensions (preventing text overflow or wrapping distortions).
  - Calculates proportional font sizes (~4.2% of video height), outlines (~10% font size), and bottom margins (~7% height).
  - Burns subtitles into video using FFmpeg `libass` filter (`-vf ass=... -c:v libx264 -preset veryfast -crf 20`).

### 4.8 Administrator Analytics Dashboard
- **Files:** `components/AdminDashboard.tsx`, `server.js`
- **Features:**
  - Real-time aggregation of generation events from Google Cloud Datastore (`GenerationLog`).
  - Scorecard metrics: Total Model Gens, Scripts, Avatars, Video Clips, Unique Users, Final Gamerhead Mixes, Horizontal vs Vertical ratio.
  - Recharts activity trends and model breakdown.
  - Searchable, sortable activity table with CSV export.
  - **Secure GCS File Access:** Generates 15-minute signed URLs via `/api/admin/signed-url` so administrators can download generated videos from private buckets without making storage public.

---

## 5. Backend API Reference (`server.js`)

All endpoints are hosted by Express on port 8080. When Google Auth is configured, all `/api/*` routes (except public config and health checks) require a `Bearer <id_token>` in the `Authorization` header.

| Endpoint | Method | Purpose | Request Body / Query | Response |
|---|---|---|---|---|
| `/healthz` | `GET` | Load balancer health check | None | `200 OK` |
| `/api/health` | `GET` | Health status & DB connectivity | None | `{ status, database, env, timestamp }` |
| `/api/config` | `GET` | Public client config | None | `{ googleClientId }` |
| `/api/auth/verify` | `POST` | Authenticate Google ID token | `{ idToken: string }` | `{ email, name, picture }` |
| `/api/log` | `POST` | Save telemetry event to Datastore | `{ userId, type, model, timestamp, status, meta }` | `{ saved: true }` |
| `/api/admin/stats` | `GET` | Fetch generation logs | `?from=ISO&to=ISO` | `{ logs: LogEntry[] }` |
| `/api/admin/signed-url` | `GET` | Get 15-min signed URL for GCS object | `?uri=gs://bucket/path` | `{ url: string }` |
| `/api/gemini/generate-script` | `POST` | Generate timed streamer script | `{ prompt, inlineData, videoMimeType, searchGrounding, gameUrl }` | `{ fullText, segments, groundingUrls, inlineData }` |
| `/api/gemini/analyze-script` | `POST` | Parse script into shot list | `{ prompt: string }` | `VeoSegment[]` |
| `/api/gemini/generate-avatar` | `POST` | Generate streamer image | `{ prompt, model, aspectRatio, referenceImageData, referenceImageMime }` | `{ imageData: string }` |
| `/api/gemini/generate-video` | `POST` | Start async Veo clip generation | `{ prompt, imageBase64, aspectRatio, durationSeconds, model }` | `{ operationName: string }` |
| `/api/gemini/video-operation` | `GET` | Poll Veo generation status | `?name=operation_name` | `{ done: bool, videoUri?, videoBase64?, error? }` |
| `/api/gemini/download-video` | `GET` | Stream video from GCS/Veo | `?uri=gs://...` or `?uri=https://...` | `video/mp4` binary stream |
| `/api/gemini/stitch-clips` | `POST` | Concat clips & burn subtitles | `multipart/form-data` (`clips`, `subtitleSrt`) | `video/mp4` binary stream |
| `/api/gemini/burn-subtitles` | `POST` | Burn subtitles on composite | `multipart/form-data` (`video`, `srt`) | `video/mp4` binary stream |

---

## 6. Prompt Engineering Architecture (`services/prompts.ts`)

The prompt engineering system ensures Veo produces natural, professional, and consistent streamer reactions:

### 1. Pronoun Standardization
All system prompts strictly enforce **gender-neutral pronouns (`they`/`them`)** when describing streamer actions.

### 2. Duration & Dialogue Word-Count Matrix
Veo video generation requires precise word counts to ensure speech matches clip duration without awkward silence or rushing:

| Duration | Slow Pacing | Normal Pacing | Fast Pacing |
|---|---|---|---|
| **4 seconds** | 8 – 10 words | 10 – 13 words | 12 – 14 words |
| **6 seconds** | 12 – 15 words | 15 – 18 words | 18 – 21 words |
| **8 seconds** | 17 – 20 words | 20 – 23 words | 23 – 26 words |

*Note: Bracketed vocal cues (e.g. `[ASMR whisper]`, `[Excited]`) are excluded from word count checks.*

### 3. Pure Human Action Rule
Streamer action prompts must **never** reference video game elements (e.g. "Reacts to dragon explosion"). Instead, they describe pure human micro-expressions and body language (e.g. "Eyes widen in shock, jaw drops, leans forward aggressively").

### 4. Gaming Device Anchoring
To prevent device morphing across frames, each device mode injects strict physical interaction constraints:
- `Mobile (Vertical)`: "Streamer holds phone VERTICALLY (Portrait) with both hands. Thumbs tapping."
- `Mobile (Horizontal)`: "Streamer holds phone HORIZONTALLY (Landscape) with both hands."
- `PC`: "Streamer interacts with keyboard and mouse on desk."
- `Console`: "Streamer holds standard gamepad/controller with both hands."
- `Hands-free (No device)`: "Streamer is completely hands-free. No devices, keyboards, or controllers visible. Looking directly into lens."

### 5. Camera & Cinematic Constraints
- Locked tripod shot (`TRIPOD SHOT. LOCKED OFF. ABSOLUTELY NO CAMERA MOVEMENT. NO ZOOM. NO PAN. NO TILT`).
- Negative prompt blocks: gameplay UI, HUDs, CGI characters next to streamer, music, and sound effects.

---

## 7. Media Processing Pipeline

```
+---------------------------------------------------------------------------------------+
|                                1. VIDEO INGESTION & COMPRESSION                       |
|   Uploaded Gameplay Video (up to 250MB)                                               |
|      │                                                                                |
|      ▼ (Client-side HTML5 Canvas resize: 720p/540p @ 2.5/1.5 Mbps)                    |
|   Compressed Base64 Payload (< 20MB) ──► Sent to Gemini 3.5 Flash for Visual Analysis |
+---------------------------------------------------------------------------------------+
                                           │
                                           ▼
+---------------------------------------------------------------------------------------+
|                                2. SHOT LIST GENERATION                                |
|   Gemini outputs timed segments (4s/6s/8s) with micro-expression prompts & dialogue  |
+---------------------------------------------------------------------------------------+
                                           │
                                           ▼
+---------------------------------------------------------------------------------------+
|                                3. VEO IMAGE-TO-VIDEO GENERATION                       |
|   Shot 1: Base Avatar Image ──────────────────────► Veo 3.1 ──► Clip 1 MP4            |
|                                                                     │                 |
|   Shot 2: Last frame extracted from Clip 1 ───────► Veo 3.1 ──► Clip 2 MP4            |
|                                                                     │                 |
|   Shot N: Last frame extracted from Clip N-1 ─────► Veo 3.1 ──► Clip N MP4            |
+---------------------------------------------------------------------------------------+
                                           │
                                           ▼
+---------------------------------------------------------------------------------------+
|                                4. COMPOSITING & POST-PRODUCTION                       |
|   Option A: Streamer Only                                                             |
|     - Server-side FFmpeg Concat (`/api/gemini/stitch-clips`)                          |
|     - Optional ASS Subtitle Burn                                                      |
|                                                                                       |
|   Option B: Final Gameplay Composite (Classic PiP / Stacked)                          |
|     - Server concatenates streamer clips                                              |
|     - Client Canvas overlays streamer over gameplay with AudioContext Gain balancing  |
|     - Client records composite Blob via MediaRecorder (10 Mbps)                       |
|     - Server burns adaptive ASS subtitles onto full frame (`/api/gemini/burn-subtitles`)|
+---------------------------------------------------------------------------------------+
```

---

## 8. Data Models & TypeScript Interfaces (`types.ts`)

```typescript
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

export interface VeoSegment {
  id: number;
  startTime: string;
  endTime: string;
  duration: 4 | 6 | 8;
  prompt: string;
  dialogue: string;
  videoUrl?: string;
  isGenerating?: boolean;
  generatedAt?: number;
  startingFrame?: 'avatar' | 'continuity';
  videoOptions?: string[];
  selectedOptionIndex?: number;
  generatedUsingPrevUrl?: string;
}

export interface AvatarConfig {
  appearance: string;
  setting: string;
  aspectRatio: '16:9' | '9:16';
  referenceImage?: string; // Base64 Data URL
  model: 'gemini-3.1-flash-image';
  gamingDevice?: string;
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
```

---

## 9. Deployment & Infrastructure (`deploy.sh`, `Dockerfile`)

### Deployment Architecture
- **Runtime:** Google Cloud Run (Fully managed serverless container).
- **Base Image:** `node:20-slim` with system `ffmpeg` installed.
- **Region:** `us-central1` (required for Veo model availability).
- **Authentication:** Application Default Credentials (ADC) via Cloud Run's Compute Service Account. No API keys required.

### Service Account IAM Roles
The deploy script automatically grants the Compute Service Account:
- `roles/storage.objectAdmin` — Read and write video files to GCS.
- `roles/iam.serviceAccountTokenCreator` — Generate signed download URLs for private bucket files.
- `roles/aiplatform.user` — Invoke Vertex AI Gemini and Veo models.
- `roles/datastore.user` — Read and write usage logs to Datastore/Firestore.
- `roles/logging.logWriter`, `roles/monitoring.metricWriter`, `roles/cloudtrace.agent` — Observability.

### Environment Variables
| Variable | Description |
|---|---|
| `GOOGLE_CLOUD_PROJECT` | GCP Project ID |
| `GCP_LOCATION` | Regional endpoint (`us-central1`) |
| `DATASTORE_DATABASE` | Firestore Database ID (`gamerhead`) |
| `GCS_BUCKET_NAME` | Bucket for persisting generated Veo videos |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Client ID for Google Sign-In |
| `AUTHORIZED_USERS` | Comma-separated whitelist of allowed user emails |
| `AUTHORIZED_DOMAIN` | Optional email domain restriction (e.g. `google.com`) |
| `BASIC_AUTH_USERS` | Optional username:password fallback authentication pairs |

### Deploy CLI Modes (`./deploy.sh`)
1. **Mode 1 (Full deployment):** Enables GCP APIs, creates Firestore database, creates GCS bucket, sets up OAuth, binds IAM roles, and builds/deploys via Cloud Build.
2. **Mode 2 (Update code):** Rebuilds and redeploys container code while preserving all existing environment variables and settings.
3. **Mode 3 (Manage users):** Updates `AUTHORIZED_USERS` list on the live Cloud Run service instantly without rebuilding.

---

## 10. Directory Structure & File Inventory

```
gamerhead/
├── App.tsx                     # Top-level state management, navigation, tab routing & auth wrapper
├── index.html                  # HTML entry point, Tailwind script, Google GSI client, Google fonts
├── index.tsx                   # React root mount
├── server.js                   # Express server, Vertex AI proxy, FFmpeg video stitcher, Datastore logger
├── types.ts                    # TypeScript types and interfaces
├── vite.config.ts              # Vite configuration with @ path alias and backend API proxy
├── package.json                # Project dependencies, build scripts, Node engine definitions
├── Dockerfile                  # Container definition with Node 20 & FFmpeg for Cloud Run
├── deploy.sh                   # Interactive bilingual GCP deployment automation script
├── DEPLOYMENT.md               # Detailed GCP Cloud Run deployment manual
├── README.md                   # Project overview and quick start guide
├── PATCH_README.md             # Change history tracking AIS-to-Master migration
├── firestore.indexes.json      # Firestore composite index definitions for generation logs
│
├── components/
│   ├── AdminDashboard.tsx      # Analytics dashboard with Recharts, scorecards, CSV export, signed GCS downloads
│   ├── AvatarGenerator.tsx     # Avatar creation lab, reference image uploader & auto-crop tool
│   ├── NeonButton.tsx          # Reusable styled button component with loading state
│   ├── ProjectForm.tsx         # Multi-step project setup (Aspect Ratio -> Layout -> Form Details)
│   └── Studio.tsx              # Shot list review, sequential Veo generation, audio mixer & final export player
│
├── services/
│   ├── auth.ts                 # Google Identity Services (GIS) integration, token storage & silent refresh
│   ├── gemini.ts               # Client-side API caller for script, avatar, Veo video, and stitching endpoints
│   ├── logging.ts              # Telemetry logger dispatching events to /api/log
│   └── prompts.ts              # Prompt engineering engine, duration rules, pacing matrices, device constraints
│
├── utils/
│   ├── subtitles.ts            # SRT parser, timestamp calculator & vocal-effect filter
│   └── videoUtils.ts           # Client Canvas video compositor, video compressor & Web Audio mixer
│
└── docs/
    └── CODEBASE_ARCHITECTURE_AND_USER_GUIDE.md # Complete codebase documentation
```

---
*Documentation compiled for developer onboarding, feature extension, and operational reference.*
