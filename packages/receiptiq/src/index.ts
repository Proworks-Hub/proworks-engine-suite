// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ReceiptIQ — read it, normalize it, learn from it.
//
// The shared receipt-intelligence layer. One application scans a receipt and
// another benefits from what was learned, without either seeing the other's
// records.
//
// The public boundary is `createReceiptIqEngine`: a raw capture in, a
// normalized private receipt out, and — only on an explicit opt-in —
// de-identified price observations that may become shared knowledge.
//
// Behind it sit the parts migrated from Family Table, where this intelligence
// was built and proven against real grocery, hardware and clothing receipts:
// the line parser, merchant normalization, unit conversion, the estimator, and
// correction-as-learning. They are exported directly too, because a host may
// want to normalize a merchant or convert a unit without a receipt in sight.
//
// Everything here is pure and I/O-free. Persistence is a set of ports a host
// implements; ReceiptIQ never opens a connection to anything.

// The boundary.
export * from "./receiptiqEngine.js";
export * from "./normalizeReceipt.js";
export * from "./boundary/contribute.js";

// Normalization — the vocabulary everything else is keyed on.
export * from "./normalize/keys.js";
export * from "./normalize/merchant.js";
export * from "./normalize/region.js";
export * from "./normalize/units.js";
export * from "./normalize/parseReceiptLines.js";
export * from "./normalize/fingerprint.js";

// Knowledge and price intelligence.
export * from "./knowledge/classifier.js";
export * from "./pricing/estimator.js";

// Extraction.
export * from "./extract/textExtractor.js";
