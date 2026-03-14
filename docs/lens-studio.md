# Lens Studio Project Notes

Development notes for the `Spectacles_OpenClaw` Lens Studio project at `lens-project/Spectacles_OpenClaw/`.

---

## Staged Image + Voice Query Flow

**Date:** March 13, 2026
**Commit:** `764d234`

### Summary

Replaced the auto-send-on-crop behavior with a two-step interaction: capture an image (two-hand pinch), then ask a question about it (right-hand pinch-and-hold voice). Images are staged — not sent — until the user provides a voice query.

### Interaction Flow

```
┌─────────────────────────────────────────────────────────┐
│  IMAGE CAPTURE (two-hand pinch)                          │
│                                                          │
│  1. Pinch both hands close → scanner spawns              │
│  2. Drag hands → crop rectangle follows                  │
│  3. Release both → image staged (not sent)               │
│     • Full-size for 2s → shrinks to lower POV            │
│     • 30s timeout → staged image discarded               │
│     • New crop within 30s replaces existing               │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  VOICE QUERY (right-hand pinch-and-hold)                 │
│                                                          │
│  1. Pinch right hand (left hand open) → ASR starts       │
│  2. Speak → live partial transcript shown in AR          │
│  3. Release → ASR stops, query dispatched:               │
│     • Image staged? → image + transcript sent together   │
│     • No image? → text-only query sent                   │
│  4. Response rendered via CaptionBehavior                │
└─────────────────────────────────────────────────────────┘
```

### Gesture Disambiguation

| Gesture | Action |
|---|---|
| Two hands pinching close together | Spawn crop scanner |
| Right hand pinch only (left open) | Start voice recording (ASR) |
| Right hand release | Stop ASR + send query |

ASR is suppressed while the crop scanner is active (`isScannerActive` flag).

### Files Changed

#### New: `Assets/Scripts/VoiceQueryController.ts`

Central controller for voice queries and image staging. Attach to a persistent SceneObject (not the scanner prefab — it outlives individual crop sessions).

**Inputs to wire in Lens Studio:**

| Input | Type | Description |
|---|---|---|
| `agent` | Agent | Same Agent component used elsewhere |
| `caption` | CaptionBehavior | For displaying AI responses (create a new one, separate from scanner) |
| `liveTranscriptText` | Text | Text component for showing live ASR transcription |
| `liveTranscriptObj` | SceneObject | Parent object of the transcript text (positioned programmatically) |
| `loadingObj` | SceneObject | Loading spinner shown during API calls |
| `editorCamObj` | SceneObject | Editor camera reference for computing positions |

**Key behaviors:**

- **`stageImage()`** — Called by PictureBehavior after crop. Holds the captured texture for 30 seconds. After 2s the crop frame animates to 0.3× scale and shifts downward. After 30s with no voice query, the staged image is discarded and the frame is destroyed.
- **Right-hand pinch-and-hold** — Starts on-device ASR (`AsrModule`, `HighAccuracy` mode, 1500ms silence threshold). Live partial transcription displayed via `liveTranscriptText`. Release stops ASR and dispatches the query.
- **Query dispatch** — If an image is staged: sends `image + transcript` via `agent.sendImageWithQuery()`. If no image: sends `transcript` via `agent.sendTextOnly()`. Response is shown via `caption.openCaption()`.
- **Gesture disambiguation** — ASR is suppressed when `isScannerActive` is true (set by PictureController during crop) or when the left hand is also pinching (would be a crop gesture).
- **Image replacement** — A new crop during the 30s staging window replaces the existing staged image and resets the timer.
- **`showResponse(text)`** — Public method used by PictureBehavior's editor auto-send path.

#### Modified: `Assets/Scripts/Agent.ts`

Added two new public methods:

- **`sendImageWithQuery(imageTex, queryText, callback)`** — Like the original `makeImageRequest` but accepts a custom query string instead of the hardcoded `"Identify in as much detail..."` prompt.
- **`sendTextOnly(queryText, callback)`** — Sends a text-only message with no image. Calls new `sendTextChat()` which builds a request body with `content: queryText` (string, not array).

Original `makeImageRequest` and `sendAgentChat` kept for backward compatibility and editor testing.

#### Modified: `Assets/Scripts/PictureBehavior.ts`

- **Removed**: `@input caption: CaptionBehavior`, `import CaptionBehavior`, `loadCaption()` method. Caption responsibility moved to VoiceQueryController.
- **Added**: `@input voiceQueryController: VoiceQueryController`.
- **`processImage()` (device path)**: No longer calls `agent.makeImageRequest()`. Instead freezes the crop, computes caption anchor position, then calls `voiceQueryController.stageImage(...)` and sets `isScannerActive = false`.
- **`processImage()` (too-small crop)**: Now resets `voiceQueryController.isScannerActive = false` before destroying — fixes a bug where ASR was permanently suppressed after a dismissed crop.
- **Editor path**: Still auto-sends via `agent.makeImageRequest()` (no ASR in editor), but routes the response through `voiceQueryController.showResponse()` instead of the removed `loadCaption()`.

#### Modified: `Assets/Scripts/PictureController.ts`

- **Added**: `@input voiceQueryController: VoiceQueryController`.
- **`createScanner()`**: Sets `voiceQueryController.isScannerActive = true` so ASR is suppressed while a crop is in progress.

### Lens Studio Scene Setup

#### 1. Create VoiceQueryController object

1. Add a new SceneObject (e.g., "VoiceQueryController") to your scene root.
2. Attach the `VoiceQueryController` script component.
3. Wire all six inputs (see table above).

#### 2. Create live transcript display

1. Create a new SceneObject (e.g., "LiveTranscript") — **not** under the caption's `scaleObj` hierarchy.
2. Add a child with a **Text** component.
3. Wire the Text to `VoiceQueryController.liveTranscriptText`.
4. Wire the parent SceneObject to `VoiceQueryController.liveTranscriptObj`.
5. Editor position doesn't matter — it's set programmatically at runtime (60 units in front of camera).

#### 3. Create response caption

1. Create a new SceneObject (e.g., "VoiceCaption") separate from the scanner prefab.
2. Add a child with a **Text** component and a wrapper for scale animation.
3. Attach **CaptionBehavior** script, wire `captionText` and `scaleObj`.
4. Wire this CaptionBehavior to `VoiceQueryController.caption`.

#### 4. Wire PictureController

On the PictureController component, set `voiceQueryController` to the VoiceQueryController object.

#### 5. Wire Scanner Prefab

On the PictureBehavior component inside the Scanner prefab, set `voiceQueryController` to the VoiceQueryController object.

#### 6. Clean up Scanner Prefab

The AI-Caption object inside the Scanner prefab is no longer used. Safe to delete it.

### API Request Formats

**Image + voice query:**
```json
{
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "<user's spoken query>" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
    ]
  }]
}
```

**Text-only voice query:**
```json
{
  "messages": [{
    "role": "user",
    "content": "<user's spoken query>"
  }]
}
```

### Bug Fixes

- **`isScannerActive` stuck at `true`**: When a crop was too small and the scanner was destroyed, `isScannerActive` was never reset, permanently blocking ASR. Fixed by resetting the flag before destroying the scanner in the too-small path.
- **`silenceUntilTerminationMs` too aggressive**: Changed from 200ms to 1500ms. 200ms would kill ASR transcription almost instantly if the user didn't start speaking the exact moment they pinched.

### Key Design Decisions

- **Editor keeps auto-send**: No ASR in editor mode, so it still uses `makeImageRequest()` with the hardcoded prompt for quick desktop testing.
- **Separate text objects**: `liveTranscriptText` (user's speech during recording) and `caption` (AI response) must be separate SceneObjects because CaptionBehavior controls visibility via scale animation.
- **Right hand only for ASR**: Left-hand pinch is reserved for crop gestures. ASR only triggers when left hand is NOT pinching and scanner is not active.
- **Image replacement**: New crop during the 30s staging window replaces the existing staged image and resets the timeout.
- **Text-only queries**: Right-hand pinch-and-hold works anytime — if no image is staged, sends a text-only request.
