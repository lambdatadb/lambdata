import { afterAll } from "bun:test";
import { cleanupTestRoot } from "./isolate";
import { stopAllTestInstances } from "./instance";

afterAll(async () => {
  try {
    await stopAllTestInstances();
  } finally {
    cleanupTestRoot();
  }
}, 120_000);
