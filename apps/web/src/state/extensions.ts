import { createExtensionsEnvironmentAtoms } from "@t3tools/client-runtime/state/extensions";

import { connectionAtomRuntime } from "../connection/runtime";

export const extensionsEnvironment = createExtensionsEnvironmentAtoms(connectionAtomRuntime);
