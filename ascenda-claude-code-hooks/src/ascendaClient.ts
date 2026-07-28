import { AscendaEventSender } from "@ascenda-one/tool-kit";
import { IngestResult, MappedAscendaEvent } from "./types.js";
import { AscendaHookConfig } from "./config.js";

export { AscendaApiError as AscendaClientError } from "@ascenda-one/tool-kit";

export class AscendaClient {
  private readonly sender: AscendaEventSender;

  constructor(config: AscendaHookConfig) {
    this.sender = new AscendaEventSender({
      apiBaseUrl: config.apiBaseUrl,
      toolInstallationId: config.toolInstallationId,
      source: "claude_code",
      eventWriteToken: config.eventWriteToken,
      tokenFilePath: config.tokenFilePath,
      sessionId: config.sessionId,
      workspaceHash: config.workspaceHash
    });
  }

  async send(mapped: MappedAscendaEvent): Promise<IngestResult> {
    return this.sender.send(mapped);
  }

  async renewEventToken(): Promise<boolean> {
    return this.sender.renewEventToken();
  }
}
