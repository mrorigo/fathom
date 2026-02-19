# Fathom

**Fathom Anything: Deep Research & Intelligence from the Command Line**

Fathom is a powerful, local-first research engine that dives deep into any topic. It recursively searches, scrapes, reads, and synthesizes information from across the web to generate comprehensive, cited reports.

By combining the breadth of search engines with the depth of LLM synthesis, Fathom goes where standard AI assistants stop—traversing links, cross-referencing sources, and building a structured knowledge base to answer complex questions.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Runtime](https://img.shields.io/badge/runtime-Bun-black)

---

## 🚀 Features

*   **Fathom the Depths**: Recursive research engine that autonomously generates queries, explores branches, and dig into topics.
*   **Smart Screening**: Automatically filters out irrelevant or low-quality URLs (e.g., login pages, generic portals).
*   **Structured Intelligence**: Extracts specific "Learning" atoms from every page visit, building a cited fact database.
*   **Citable Reports**: Generates professional Markdown reports with inline citations and a full bibliography.
*   **Local & Private**: Designed to work with local LLMs (Ollama) or OpenAI-compatible APIs.
*   **Live Feedback**: See what Fathom is reading and learning in real-time with verbose mode.
*   **Token Tracking**: Keeps track of your LLM usage throughout the session.

## 🛠 Prerequisites

*   **[Bun](https://bun.sh/)**: The fast JavaScript runtime.
*   **[Ollama](https://ollama.com/)** (Optional): For running local LLMs like `llama3` or `gemma`.
*   **OpenAI API Key** (Optional): If you prefer using GPT-4o or other cloud models.

## 📦 Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/yourusername/fathom.git
cd fathom
bun install
```

### Link Locally (`bun link`)

From this repo:

```bash
bun link
```

From any other Bun project where you want to use the CLI:

```bash
bun link fathom
fathom "The history of the sauna"
```

## ⚡ Usage

Run Fathom directly from your terminal:

```bash
# Basic usage from source (defaults to local Ollama)
bun run src/cli/index.ts "The history of the sauna"
```

If linked, run it as:

```bash
fathom "The history of the sauna"
```

## 📦 Single Binary Build

Build a standalone executable with Bun:

```bash
bun run build
```

Output binary path:

```bash
./dist/fathom
```

Release-style binary (minified + bytecode):

```bash
bun run build:release
```

### Options

| Flag                   | Description                                          | Default                     |
| :--------------------- | :--------------------------------------------------- | :-------------------------- |
| `-d, --depth`          | Recursion depth (how many clicks deep to go)         | 2                           |
| `-b, --breadth`        | Breadth (how many search queries/links per level)    | 3                           |
| `-m, --model`          | LLM Model to use (e.g., `llama3`, `gpt-4o`)          | `llama3`                    |
| `-v, --verbose`        | Stream detailed research events/learnings to console | `false`                     |
| `--api-key`            | OpenAI API Key (or `ollama` for local mode)          | `OPENAI_API_KEY` or `ollama` |
| `--api-endpoint`       | Custom API Endpoint                                  | `http://localhost:11434/v1` |
| `--learnings-per-page` | Max facts to extract per page                        | 5                           |
| `--max-results`        | Max search results to process per query              | 5                           |
| `-o, --output`         | Save the final report to a specific file             | `report.md`                 |
| `-l, --log-file`       | Save structured logs (JSONL) to specific file        | `research.jsonl`            |

### Examples

**Deep Dive on a Complex Topic (Local LLM):**
```bash
bun run src/cli/index.ts "Impact of microplastics on deep sea ecosystems" \
  --depth 3 \
  --breadth 4 \
  --verbose \
  --model mistral
```

**Quick Summary using OpenAI (Faster/Smarter):**
```bash
bun run src/cli/index.ts "Latest developments in solid state batteries" \
  --api-key sk-proj-123... \
  --api-endpoint https://api.openai.com/v1 \
  --model gpt-4o-mini
```

**Custom Research Balance:**
```bash
# Focus on breadth (many sources) but shallow depth
bun run src/cli/index.ts "Top 10 tourist destinations in Finland" --breadth 5 --depth 1
```

## 🏗 Architecture

Fathom operates in a loop:
1.  **Synthesize**: The Engine analyzes current Learnings and generates new Search Queries.
2.  **Hunt**: Searches the web (DuckDuckGo Lite) for these queries.
3.  **Read**: Scrapes content, converting HTML to clean Markdown.
4.  **Extract**: Uses an LLM to extract key "Learnings" and "Follow-up Questions" from the content.
5.  **Repeat**: Recursively dives deeper based on follow-up questions.
6.  **Report**: Finally, synthesizes all Learnings into a cited, professional report.

## 📄 Output

*   **Final Report**: A markdown file with an Executive Summary, cited sections, and References.
*   **Structured Logs**: A JSONL file recording every step, query, and extracted fact (great for debugging or replay).

## 📜 License

MIT
