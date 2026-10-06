import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const cwd = z.string().min(1).nullable();
const counts = z.object({ commands: z.number().int().nonnegative(), skillRoots: z.number().int().nonnegative() }).strict();

export const hostContract = defineRpcContract({
  prepareRuntime: {
    input: z.null(),
    output: z.object({ launcher: z.string().min(1) }).strict(),
  },
  syncCommands: { input: z.object({ cwd }).strict(), output: counts },
});

export const rpcContract = defineRpcContract({
  syncCommands: { input: z.object({ hostId: z.string().min(1), cwd }).strict(), output: counts },
});
