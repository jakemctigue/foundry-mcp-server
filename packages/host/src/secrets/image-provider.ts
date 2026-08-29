import type { SecretStorage } from "./storage.js";

export const OPENAI_IMAGES_API_KEY_SECRET = "openai-images-api-key";

export async function saveOpenAiImagesApiKey(
  storage: SecretStorage,
  apiKey: string,
): Promise<void> {
  if (apiKey.trim().length < 8) throw new Error("OpenAI Images API key is invalid");
  await storage.save(OPENAI_IMAGES_API_KEY_SECRET, Buffer.from(apiKey.trim(), "utf8"));
}

export async function loadOpenAiImagesApiKey(storage: SecretStorage): Promise<string | undefined> {
  const stored = await storage.load(OPENAI_IMAGES_API_KEY_SECRET);
  if (!stored) return undefined;
  const value = stored.toString("utf8").trim();
  return value.length > 0 ? value : undefined;
}

export async function removeOpenAiImagesApiKey(storage: SecretStorage): Promise<void> {
  if (!storage.remove) throw new Error("secret storage does not support secure removal");
  await storage.remove(OPENAI_IMAGES_API_KEY_SECRET);
}
