# Contributing

Open an issue describing the problem or proposed change before large changes. Small fixes can go directly into a pull request.

Use the setup and test commands in the README. Run unit tests and the Electron GUI smoke test before sending a pull request. Add meaningful regression coverage for behavior changes, especially subprocess cancellation, attachment parsing, saved data, and moderator validation. The normal tests use fake CLIs and temporary data; live tests require your own accounts and consume usage.

Do not commit credentials, personal conversations, documents, local profiles, generated installers, or test output. Keep model content as untrusted data and preserve the sandboxed renderer and restricted IPC bridge. Public logs and screenshots should use fictional examples.

Describe what changed, why it changed, and how you checked it. Include the OS and architecture when changing platform behavior.
