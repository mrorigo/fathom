
import { Command } from "commander";
import ora from "ora";
import chalk from "chalk";
import { DeepResearchEngine, type LogEvent, type TokenUsage } from "../core/engine.ts";
import fs from "fs/promises";
import path from "path";

const program = new Command();

program
    .name("fathom")
    .description("Fathom - Fathom Anything: Deep Research & Intelligence from the Command Line")
    .version("1.0.0")
    .argument("<prompt>", "The research topic")
    .option("-d, --depth <number>", "Research depth (recursion levels)", "2")
    .option("-b, --breadth <number>", "Research breadth (queries per level)", "3")
    .option("-c, --concurrency <number>", "Max concurrent tasks", "5")
    .option("-m, --model <string>", "LLM Model to use", "llama3")
    .option("--api-key <string>", "OpenAI API Key (or 'ollama')", "ollama")
    .option("--api-endpoint <string>", "OpenAI Base URL", "http://localhost:11434/v1")
    .option("-o, --output <string>", "Output file path")
    .option("-l, --log-file <string>", "Structured log file path", "research.jsonl")
    .option("-v, --verbose", "Show detailed research events in console", false)
    .option("--learnings-per-page <number>", "Max learnings to extract per page", "5")
    .option("--max-results <number>", "Max search results to process per query", "5")
    .action(async (prompt, options) => {
        const spinner = ora(chalk.blue("Initializing Deep Research...")).start();
        const logFile = options.logFile;
        const verbose = options.verbose;

        // Helper to truncate long strings (URLs/Queries) for cleaner console output
        const truncate = (str: string, max: number = 80) => {
            if (str.length <= max) return str;
            return str.substring(0, max - 3) + "...";
        };

        try {
            const config = {
                depth: parseInt(options.depth),
                breadth: parseInt(options.breadth),
                concurrency: parseInt(options.concurrency),
                learningsPerChunk: parseInt(options.learningsPerPage),
                maxSearchResultsPerQuery: parseInt(options.maxResults),
                minLearnings: 5, // Kept for internal logic if needed, though mostly unused now
            };

            const llmOptions = {
                model: options.model,
                apiKey: options.apiKey,
                baseURL: options.apiEndpoint
            };

            const engine = new DeepResearchEngine(config, llmOptions);

            engine.on("event", (event: LogEvent, usage: TokenUsage) => {
                const logEntry = {
                    timestamp: new Date().toISOString(),
                    event,
                    usage
                };
                fs.appendFile(logFile, JSON.stringify(logEntry) + "\n").catch(() => { });

                if (verbose) {
                    const wasSpinning = spinner.isSpinning;
                    if (wasSpinning) spinner.stop();

                    switch (event.type) {
                        case "query_generated":
                            console.log(chalk.blue(`🔍 Generated ${event.count} queries (Depth ${event.depth})`));
                            event.queries.forEach(q => console.log(chalk.gray(`  - ${q}`)));
                            break;
                        case "search":
                            console.log(chalk.yellow(`🔎 Searched: "${truncate(event.query)}"`));
                            break;
                        case "scrape":
                            const color = event.status === "success" ? chalk.green : chalk.red;
                            console.log(color(`📄 Scrape ${event.status}: ${truncate(event.url)}`));
                            break;
                        case "learnings":
                            console.log(chalk.green(`💡 Learned ${event.count} facts from ${truncate(event.url)}`));
                            if (event.learnings) {
                                event.learnings.forEach(l => console.log(chalk.gray(`  - ${l}`)));
                            }
                            break;
                        case "error":
                            console.log(chalk.red(`⚠️ Error: ${event.message}`));
                            break;
                    }

                    if (wasSpinning) spinner.start();
                }
            });

            spinner.text = chalk.yellow(`Starting research on: "${prompt}"`);

            // Initial log
            if (verbose) {
                spinner.stop();
                console.log(chalk.cyan("🚀 Research Configuration:"));
                console.log(`   Depth: ${config.depth}`);
                console.log(`   Breadth: ${config.breadth}`);
                console.log(`   Learnings/Page: ${config.learningsPerChunk}`);
                console.log(`   Max Results/Query: ${config.maxSearchResultsPerQuery}`);
                console.log(`   Model: ${llmOptions.model}`);
                console.log(`   Endpoint: ${llmOptions.baseURL}\n`);
                spinner.start();
            }

            const startTime = Date.now();
            const state = await engine.run(prompt);

            const duration = ((Date.now() - startTime) / 1000).toFixed(1);

            spinner.stop();
            console.log(chalk.green(`\n✅ Research completed in ${duration}s`));
            console.log(`   Learnings: ${state.learnings.length}`);
            console.log(`   Sources: ${state.visitedUrls.size}`);
            console.log(chalk.gray(`   Tokens: ${state.tokenUsage.total} (Prompt: ${state.tokenUsage.prompt}, Completion: ${state.tokenUsage.completion})`));

            const reportSpinner = ora(chalk.blue("Writing final report...")).start();
            const report = await engine.generateReport(prompt);
            reportSpinner.succeed("Report generated!");

            if (options.output) {
                await fs.writeFile(options.output, report);
                console.log(chalk.green(`\n📄 Report saved to: ${options.output}`));
            } else {
                console.log(chalk.white("\n" + "=".repeat(50)));
                console.log(chalk.bold("FINAL REPORT"));
                console.log("=".repeat(50) + "\n");
                console.log(report);
                console.log(chalk.white("\n" + "=".repeat(50)));
            }

        } catch (error) {
            spinner.fail("Research failed");
            console.error(chalk.red(error));
            process.exit(1);
        }
    });

program.parse();
