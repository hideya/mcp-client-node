//
// Ref: https://github.com/modelcontextprotocol/docs/blob/main/tutorials/building-a-client-node.mdx
//

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as readline from "node:readline";

dotenv.config();

interface MCPClientConfig {
  name?: string;
  version?: string;
}

class MCPClient {
  private client: Client | null = null;
  private anthropic: Anthropic;
  private transport: StdioClientTransport | null = null;

  constructor(config: MCPClientConfig = {}) {
    this.anthropic = new Anthropic();
  }

  async connectToServer(serverScriptPath: string): Promise<void> {
    const isPython = serverScriptPath.endsWith(".py");
    const isJs = serverScriptPath.endsWith(".js");

    if (!isPython && !isJs) {
      throw new Error("Server script must be a .py or .js file");
    }

    const command = isPython ? "python" : "node";

    this.transport = new StdioClientTransport({
      command,
      args: [serverScriptPath],
    });

    this.client = new Client(
      {
        name: "mcp-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );

    await this.client.connect(this.transport);

    // List available tools
    const response = await this.client.request(
      { method: "tools/list" },
      ListToolsResultSchema
    );

    console.log(
      "\nConnected to server with tools:",
      response.tools.map((tool: any) => tool.name)
    );
  }

  async processQuery(query: string): Promise<string> {
    if (!this.client) {
      throw new Error("Client not connected");
    }

    // Initialize messages array with user query
    let messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: query,
      },
    ];

    // Get available tools
    const toolsResponse = await this.client.request(
      { method: "tools/list" },
      ListToolsResultSchema
    );

    const availableTools = toolsResponse.tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));

    const finalText: string[] = [];
    let currentResponse = await this.anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1000,
      messages,
      tools: availableTools,
    });

    // Process the response and any tool calls
    while (true) {
      // Add Claude's response to final text and messages
      for (const content of currentResponse.content) {
        if (content.type === "text") {
          finalText.push(content.text);
        } else if (content.type === "tool_use") {
          const toolName = content.name;
          const toolArgs = content.input;

          // Execute tool call
          const result = await this.client.request(
            {
              method: "tools/call",
              params: {
                name: toolName,
                arguments: toolArgs,
              },
            },
            CallToolResultSchema
          );

          finalText.push(
            `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`
          );

          // Add Claude's response (including tool use) to messages
          messages.push({
            role: "assistant",
            content: currentResponse.content,
          });

          // Add tool result to messages
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: content.id,
                content: [
                  { type: "text", text: JSON.stringify(result.content) },
                ],
              },
            ],
          });

          // Get next response from Claude with tool results
          currentResponse = await this.anthropic.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 1000,
            messages,
            tools: availableTools,
          });

          // Add Claude's interpretation of the tool results to final text
          if (currentResponse.content[0]?.type === "text") {
            finalText.push(currentResponse.content[0].text);
          }

          // Continue the loop to process any additional tool calls
          continue;
        }
      }

      // If we reach here, there were no tool calls in the response
      break;
    }

    return finalText.join("\n");
  }

  async chatLoop(): Promise<void> {
    console.log("\nMCP Client Started!");
    console.log("Type your queries or 'quit' to exit.");

    // Using Node's readline for console input
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const askQuestion = () => {
      rl.question("\nQuery: ", async (query: string) => {
        try {
          if (query.toLowerCase() === "quit") {
            await this.cleanup();
            rl.close();
            return;
          }

          const response = await this.processQuery(query);
          console.log("\n" + response);
          askQuestion();
        } catch (error) {
          console.error("\nError:", error);
          askQuestion();
        }
      });
    };

    askQuestion();
  }

  async cleanup(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
    }
  }
}

// Main execution
async function main() {
  if (process.argv.length < 3) {
    console.log("Usage: ts-node client.ts <path_to_server_script>");
    process.exit(1);
  }

  const client = new MCPClient();
  try {
    await client.connectToServer(process.argv[2]);
    await client.chatLoop();
  } catch (error) {
    console.error("Error:", error);
    await client.cleanup();
    process.exit(1);
  }
}

// Run main if this is the main module
if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main();
}

export default MCPClient;
