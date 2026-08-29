import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLocalImageLoader } from "../src/assets/local-file.js";
import { DeterministicImageProvider } from "../src/providers/images.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

describe("local image loader", () => {
  it("checks allowed roots and file size before reading a valid image", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-mcp-image-"));
    temporaryDirectories.push(directory);
    const image = await new DeterministicImageProvider().generate("local fixture");
    const filePath = path.join(directory, "fixture.png");
    await fs.writeFile(filePath, image.bytes);
    const load = createLocalImageLoader({ allowedRoots: [directory] });
    expect(await load(filePath)).toMatchObject({ mimeType: "image/png", bytes: image.bytes });
    await expect(load(filePath, image.bytes.byteLength - 1)).rejects.toThrow("byte limit");
    await expect(load(path.resolve(directory, "..", "outside.png"))).rejects.toThrow(
      "outside configured roots",
    );
  });
});
