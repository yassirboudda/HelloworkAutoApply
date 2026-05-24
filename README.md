# HelloworkAutoApply

Chrome/Chromium extension to auto-apply on Hellowork with a workflow inspired by LinkedInAutoApply.

## Features

- Start session from popup (keywords, location, contract, max jobs).
- Auto navigation search -> offer -> apply -> back to search.
- Detect success pages (`/bounce/multiapply`, `/bounce/createalert`).
- Session state and logs stored in `chrome.storage.local`.
- Safety stop to avoid endless loops when no offers can be applied.

## Load in Chromium

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select folder: `helloworkAutoApply/HelloworkAutoApply`.

## Notes

- This is V1 generated from teach-agent browsing trace behavior.
- Hellowork DOM can change; selectors may need quick iterations after your tests.
