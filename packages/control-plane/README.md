# @proworks-hub/control-plane

The engine control centre's portable core: engine manifests, operational state,
internal console authorization, hive topology, and the telemetry-to-visualization
adapter.

**It observes the engines. It never runs them.** Nothing in this package is
imported by any engine — a portability guard fails the build if that changes. If
the console were offline or deleted, every engine would keep working exactly as
it does now.

```ts
import { createEngineRegistry, deriveEngineHealth, resolveEngineConsoleAccess } from "@proworks-hub/control-plane";
import { SUITE_MANIFESTS } from "@proworks-hub/control-plane/manifests";
import { EngineVisual, MotionProvider } from "@proworks-hub/control-plane/react";
```

`react` is an **optional** peer. A host that wants only the manifests, the health
model or the authorization rules never loads it.

Architecture, security boundary, role model, manifest specification and the
guides for adding an engine, artwork or an event animation:
[`docs/ENGINE-CONTROL-CENTER.md`](../../docs/ENGINE-CONTROL-CENTER.md).

Copyright (c) 2026 Steven Kreutzer. All rights reserved.
