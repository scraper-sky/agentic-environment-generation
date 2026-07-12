import "dotenv/config";
import OpenAI from "openai";

// gpt-4o-mini is cheaper but noticeably less reliable at the traversal agent's
// spatial/tactical judgment calls (e.g. jumping "to maintain momentum" with no
// gap actually ahead) — gpt-4o is the more consistent default; override via
// OPENAI_MODEL for a cheaper/faster run.
const DEFAULT_MODEL = "gpt-4o";

export const OPENAI_MODEL = process.env["OPENAI_MODEL"]?.trim() || DEFAULT_MODEL;

let client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (client) return client;
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set. Copy .env.example to .env and add your key — see README.md for setup.");
  }
  client = new OpenAI({ apiKey });
  return client;
}
