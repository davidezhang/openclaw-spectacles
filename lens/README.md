# Lens Setup Guide

This guide walks you through importing `SpectaclesOpenClaw.ts` into Lens Studio and wiring it up for your Spectacles.

## Requirements

- [Lens Studio](https://ar.snap.com/lens-studio) 5.x or later
- A Snap Spectacles device paired via the Spectacles app
- The auth proxy running locally (see root [`README.md`](../README.md))
- A Cloudflare Tunnel URL pointing at the proxy

## Step 1 — Create or open a project

Open Lens Studio and either start a **New Project** (use the _Spectacles_ template for the correct device target) or open an existing lens.

## Step 2 — Import the script

1. In the **Asset Browser**, right-click → **Import Files**.
2. Select `SpectaclesOpenClaw.ts` from this repo.
3. The file will appear in the Asset Browser under `Scripts/`.

## Step 3 — Add the component to a Scene Object

1. In the **Scene Hierarchy**, select the Scene Object that should host the logic (e.g., a root `ScriptController` object).
2. In the **Inspector**, click **Add Component** → **Script**.
3. Drag `SpectaclesOpenClaw` from the Asset Browser into the **Script** slot.

## Step 4 — Create a Text component

1. In the Hierarchy, add a **Screen Text** object (right-click → **Add Object** → **Screen Text**).
2. Position it where you want the reply to appear in the AR view.
3. Give it a readable font size and color — white on a semi-transparent background works well on Spectacles.

## Step 5 — Wire the Inspector inputs

With the Script Component selected, fill in the following fields:

| Input | Type | Value |
|---|---|---|
| **Internet Module** | InternetModule | Select the **Internet Module** from the dropdown (it is added automatically to new projects; add it via **Add Component** → **Internet Module** if missing) |
| **Reply Text** | Text | Drag your Screen Text object's Text component here |
| **Endpoint** | string | `https://your-tunnel.trycloudflare.com` (no trailing slash) |
| **Session Key** | string | _(optional)_ Your OpenClaw session key |
| **Test Message** | string | `hello from spectacles` _(or whatever you want to ask)_ |
| **Auto Send Delay Sec** | number | `2` _(seconds after lens loads before the message fires)_ |

> **Tip:** Leave `Session Key` blank if your OpenClaw setup does not require one.

## Step 6 — Enable Internet access in Project Settings

1. Open **File** → **Project Info**.
2. Under **Permissions**, enable **Internet Access**.

Without this, `InternetModule` requests will silently fail.

## Step 7 — Test in the Preview

Press **Play** in Lens Studio. After `autoSendDelaySec` seconds you should see the Text component update with the response from OpenClaw. If it shows an `[Error]` message, check [`docs/troubleshooting.md`](../docs/troubleshooting.md).

## Step 8 — Push to Spectacles

Use the **Spectacles** push button (lightning bolt icon) in Lens Studio to sideload the lens directly to your paired device.

## Notes

- **No Authorization header** is set in the TypeScript code. Lens Studio's `InternetModule` strips it. The local proxy handles auth injection instead.
- The `autoSendDelaySec` delay is intentional — it replaces a button press for hands-free interaction.
- To use a real voice or gesture trigger, swap the `DelayedCallbackEvent` for a `TapEvent` or voice command event in the TypeScript file.
