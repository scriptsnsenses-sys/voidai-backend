import { ProviderRegistry } from '../services';
import { ModelRegistryService } from '../../../domain/provider';
import type { ModelsResponse, ModelInfo } from '../types';
import type { ILogger } from '../../../core/logging';

interface ProviderStats {
  readonly totalProviders: number;
  readonly totalModels: number;
  readonly modelsByProvider: Record<string, number>;
  readonly capabilityStats: Record<string, number>;
}

export class ModelsService {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly modelRegistry: ModelRegistryService,
    private readonly logger: ILogger
  ) {}

  getAvailableModels(): ModelsResponse {
    try {
      const allModels = this.modelRegistry.getAllModels();
      
      this.logger.info('Retrieved available models', {
        metadata: {
          modelCount: allModels.length
        }
      });

      return {
        object: 'list',
        data: allModels.map(model => this.transformModelToResponse(model))
      };

    } catch (error) {
      this.logger.error('Failed to fetch available models', error as Error);
      throw error;
    }
  }

  getModelInfo(modelId: string): any {
    if (!modelId?.trim()) {
      throw new Error('Model ID is required');
    }

    try {
      const model = this.modelRegistry.getById(modelId);

      if (!model) {
        this.logger.warn('Model not found', {
          metadata: { modelId }
        });
        throw new Error(`Model ${modelId} not found`);
      }

      this.logger.info('Retrieved model info', {
        metadata: {
          modelId,
          ownedBy: model.ownedBy
        }
      });

      return this.transformModelToResponse(model);

    } catch (error) {
      this.logger.error('Failed to get model info', error as Error, {
        metadata: { modelId }
      });
      throw error;
    }
  }

  async getProviderStats(): Promise<ProviderStats> {
    try {
      const registryStats = this.providerRegistry.getRegistryStats();
      const allModels = this.modelRegistry.getAllModels();
      const modelsByProvider = this.calculateModelsByProvider([...allModels]);

      const stats: ProviderStats = {
        totalProviders: registryStats.totalAdapters,
        totalModels: this.modelRegistry.getModelCount(),
        modelsByProvider,
        capabilityStats: registryStats.adaptersByCapability
      };

      this.logger.info('Generated provider stats', {
        metadata: {
          totalProviders: stats.totalProviders,
          totalModels: stats.totalModels,
          uniqueProviders: Object.keys(modelsByProvider).length
        }
      });

      return stats;

    } catch (error) {
      this.logger.error('Failed to get provider stats', error as Error);
      throw error;
    }
  }

  private transformModelToResponse(model: any): ModelInfo {
    return {
      id: model.id,
      object: 'model',
      owned_by: model.ownedBy,
      endpoints: model.endpoints,
      cost_type: model.costType,
      base_cost: model.baseCost,
      multiplier: model.multiplier,
      supports_streaming: model.supportsStreaming,
      supports_tool_calling: model.supportsToolCalling
    };
  }

  private calculateModelsByProvider(models: any[]): Record<string, number> {
    return models.reduce((acc, model) => {
      const provider = model.ownedBy;
      acc[provider] = (acc[provider] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  }
}