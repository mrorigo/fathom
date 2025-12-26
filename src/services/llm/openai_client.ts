
import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";

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

            // Sometimes models might wrap in ```json ... ``` or just return the JSON string.
            // The OpenAI SDK's parse helper is usually great, but let's do a safe parse.
            // Since we used zodResponseFormat, we should expect a valid JSON string structure conforming to the schema.
            // However, OLLAMA implementation of json mode might vary.

            return {
                object: JSON.parse(content),
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
