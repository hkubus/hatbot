import {
  type CreateParams,
  ModelError,
  type ModelInfo,
  type ModelProvider,
  type StreamHandlers,
  type StreamParams,
} from "@hatbot/plugin-sdk";
import type { Plugins } from "../plugins/registry";
import type { ModelClient } from "./model";

/** Sends each request to the ready provider whose catalogue has its model. */
export class Models implements ModelClient {
  constructor(private plugins: Plugins) {}

  catalogue(): (ModelInfo & { provider: string })[] {
    return this.plugins
      .modelProviders()
      .flatMap(({ id, provider }) => provider.models().map((m) => ({ ...m, provider: id })));
  }

  async stream(params: Omit<StreamParams, "stream">, handlers: StreamHandlers) {
    return this.providerOf(params.model).stream(params, handlers);
  }

  async create(params: CreateParams) {
    return this.providerOf(params.model).create(params);
  }

  private providerOf(model: string): ModelProvider {
    const found = this.plugins
      .modelProviders()
      .find(({ provider }) => provider.models().some((m) => m.id === model));
    if (!found)
      throw new ModelError(
        `no model provider that's on offers ${model}; pick another in Settings → Models`,
      );
    return found.provider;
  }
}
