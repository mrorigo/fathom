
import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";

function parseModelJsonOutput(raw: string): unknown {
    const trimmed = raw.trim();

    // Fast path for valid JSON.
    try {
        return JSON.parse(trimmed);
    } catch {
        // Continue with tolerant parsing paths.
    }

    // Handle fenced code blocks like ```json ... ``` or ``` ... ```.
    const fencedBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
    for (const match of trimmed.matchAll(fencedBlockRegex)) {
        const candidate = match[1]?.trim();
        if (!candidate) continue;
        try {
            return JSON.parse(candidate);
        } catch {
            // Try next block.
        }
    }

    // Handle responses that include text before/after a JSON object/array.
    const embedded = extractFirstJsonValue(trimmed);
    if (embedded) {
        return JSON.parse(embedded);
    }

    throw new Error("Unable to parse JSON from model response");
}

function extractFirstJsonValue(input: string): string | null {
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaping = false;
    let opening: "{" | "[" | null = null;
    let closing: "}" | "]" | null = null;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];

        if (inString) {
            if (escaping) {
                escaping = false;
                continue;
            }
            if (ch === "\\") {
                escaping = true;
                continue;
            }
            if (ch === "\"") {
                inString = false;
            }
            continue;
        }

        if (ch === "\"") {
            inString = true;
            continue;
        }

        if (start === -1) {
            if (ch === "{" || ch === "[") {
                start = i;
                opening = ch;
                closing = ch === "{" ? "}" : "]";
                depth = 1;
            }
            continue;
        }

        if (ch === opening) depth++;
        if (ch === closing) {
            depth--;
            if (depth === 0) {
                return input.slice(start, i + 1);
            }
        }
    }

    return null;
}

export class LLMClient {
    private client: OpenAI;
    private model: string;

    constructor(options?: {
        apiKey?: string;
        baseURL?: string;
        model?: string;
    }) {
        const baseURL = options?.baseURL ||
            process.env.OPENAI_BASE_URL ||
            "http://localhost:11434/v1";
        console.log("Base URL: " + baseURL);
        this.client = new OpenAI({
            apiKey: options?.apiKey || process.env.OPENAI_API_KEY || "ollama",
            baseURL

        });
        this.model =
            options?.model || process.env.LLM_MODEL || "llama3";
    }

    async generateText(
        prompt: string,
        systemPrompt: string = "You are a helpful assistant."
    ): Promise<{ content: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
        try {
            const response = await this.client.chat.completions.create({
                model: this.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: prompt },
                ],
            });

            return {
                content: response.choices[0]?.message?.content || "",
                usage: response.usage,
            };
        } catch (error) {
            console.error("Error in generateText:", error);
            throw error;
        }
    }

    async generateObject<T extends z.ZodType>(
        prompt: string,
        schema: T,
        systemPrompt: string = "You are a helpful assistant."
    ): Promise<{ object: z.infer<T>; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
        try {
            const response = await this.client.chat.completions.create({
                model: this.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: prompt },
                ],
                response_format: zodResponseFormat(schema, "result"),
            });

            const content = response.choices[0]?.message?.content;
            if (!content) {
                throw new Error("No content received from LLM");
            }

            const parsed = parseModelJsonOutput(content);
            const object = schema.parse(parsed);

            return {
                object,
                usage: response.usage,
            };
        } catch (error) {
            console.error("Error in generateObject:", error);
            // Fallback for models that don't support native JSON mode perfectly or if using a provider that ignores it.
            // We could try to extract JSON from text here.
            throw error;
        }
    }
}
