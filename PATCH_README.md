# Patch README - GamerHeads Codebase Update

This file documents the feature updates and patches applied from the AIS (sandbox) version to the Master version.

## Applied Patches

### Prompts (`services/prompts.ts`)
-   Adopted gender-neutral pronoun rule (`they`/`them`) for streamer descriptions.
-   Updated word count limits to recommendations for better pacing.
-   Added support for `Hands-free (No device)` gaming device option.

### Gemini Integration (`services/gemini.ts`)
-   Updated `generateVeoClip` to pass `gamingDevice` to `constructVeoGenerationPrompt`.

### UI Components
-   `App.tsx`: Passed `gamingDevice` prop to `Studio` component.
-   `components/Studio.tsx`: Passed `gamingDevice` to `generateVeoClip`.
-   `components/ProjectForm.tsx`: Added `Hands-free (No device)` option to the UI.

## Rejected Changes (Preserved Master Architecture)
The following changes from AIS were REJECTED to protect the core deployment architecture of the Master version:
-   Did NOT switch to `@google/genai` SDK or direct client-side calls.
-   Did NOT remove server-side API proxying.
-   Did NOT remove Google Sign-in wrappers.
-   Did NOT change model names to `-preview`.
-   Did NOT modify dependencies in `package.json` (retained Datastore/Storage, did not add GenAI SDK or Firebase Admin).
