// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// @proworks-hub/notifications — deciding who should be told what.
//
// The hard part is not sending. It is NOT sending: not twice, not at 3am, not
// about something that gets corrected a minute later, and not to somebody who
// asked you to stop. Every rule in here exists to make one of those refusals
// possible.
//
// It decides and records; the host sends. Sending is I/O a pure package cannot
// make transactional or retryable, and a service that both decides and sends
// cannot be tested for what it decides without stubbing a mail server.

export * from "./models.js";
export * from "./policy.js";
export * from "./service.js";
export * from "./inMemory.js";
