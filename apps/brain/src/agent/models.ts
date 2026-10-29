import { ModelError, type ModelInfo, type ModelProvider } from "@hatbot/plugin-sdk";
import type { Plugins } from "../plugins/registry";
import type { CreateParams, ModelClient, StreamHandlers, StreamParams } from "./model";

export type CatalogueModel = ModelInfo & { provider: string };

/** Sends each request to the ready provider whose catalogue has its model. */
export class Models implements ModelClient {
  constructor(private plugins: Plugins) {}

  catalogue(): CatalogueModel[] {
    return this.plugins
      .modelProviders()
      .flatMap(({ id, provider }) => provider.models().map((m) => ({ ...m, provider: id })));
  }

  info(model: string): CatalogueModel | null {
    return this.catalogue().find((m) => m.id === model) ?? null;
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
    if (!found) throw new ModelError(`no model provider that's on offers ${model}`);
    return found.provider;
  }
}
