import { encodeRouteToPath } from '@uniswap/v3-sdk';
import { default as AsyncRetry, default as retry } from 'async-retry';
import { BigNumber, providers } from 'ethers';
import _ from 'lodash';
import stats from 'stats-lite';
import { V3Route } from '../../routers/router';
import { IQuoterV2__factory } from '../../types/v3/factories/IQuoterV2__factory';
import { ChainId, metric, MetricLoggerUnit } from '../../util';
import { QUOTER_V2_ADDRESS } from '../../util/addresses';
import { CurrencyAmount } from '../../util/amounts';
import { log } from '../../util/log';
import { routeToString } from '../../util/routes';
import { Result } from '../multicall-provider';
import { UniswapMulticallProvider } from '../multicall-uniswap-provider';
import { ProviderConfig } from '../provider';

const chainToQuoterAddress: { [chainId in ChainId]?: string } = {
  [ChainId.MAINNET]: QUOTER_V2_ADDRESS,
  [ChainId.RINKEBY]: '0xbec7965F684FFdb309b9189BDc10C31337C37CBf',
};

/**
 * A quote for a swap on V3.
 */
export type V3AmountQuote = {
  amount: CurrencyAmount;
  /**
   * Quotes can be null (e.g. pool did not have enough liquidity).
   */
  quote: BigNumber | null;
  /**
   * For each pool in the route, the sqrtPriceX96 after the swap.
   */
  sqrtPriceX96AfterList: BigNumber[] | null;
  /**
   * For each pool in the route, the number of ticks crossed.
   */
  initializedTicksCrossedList: number[] | null;
  /**
   * An estimate of the gas used by the swap. This is returned by the multicall
   * and is not necessarily accurate due to EIP-2929 causing gas costs to vary
   * depending on if the slot has already been loaded in the call.
   */
  gasEstimate: BigNumber | null;
};

export class BlockConflictError extends Error {
  public name = 'BlockConflictError';
}
export class SuccessRateError extends Error {
  public name = 'SuccessRateError';
}

export class ProviderBlockHeaderError extends Error {
  public name = 'ProviderBlockHeaderError';
}

export class ProviderTimeoutError extends Error {
  public name = 'ProviderTimeoutError';
}

/**
 * This error typically means that the gas used by the multicall has
 * exceeded the total call gas limit set by the node provider.
 *
 * This can be resolved by modifying BatchParams to request fewer
 * quotes per call, or to set a lower gas limit per quote.
 *
 * @export
 * @class ProviderGasError
 */
export class ProviderGasError extends Error {
  public name = 'ProviderGasError';
}

export type QuoteRetryOptions = AsyncRetry.Options;

/**
 * The V3 route and a list of quotes for that route.
 */
export type V3RouteWithQuotes = [V3Route, V3AmountQuote[]];

type QuoteBatchSuccess = {
  status: 'success';
  inputs: [string, string][];
  results: {
    blockNumber: BigNumber;
    results: Result<[BigNumber, BigNumber[], number[], BigNumber]>[];
    approxGasUsedPerSuccessCall: number;
  };
};

type QuoteBatchFailed = {
  status: 'failed';
  inputs: [string, string][];
  reason: Error;
  results?: {
    blockNumber: BigNumber;
    results: Result<[BigNumber, BigNumber[], number[], BigNumber]>[];
    approxGasUsedPerSuccessCall: number;
  };
};

type QuoteBatchPending = {
  status: 'pending';
  inputs: [string, string][];
};

type QuoteBatchState = QuoteBatchSuccess | QuoteBatchFailed | QuoteBatchPending;

/**
 * Provider for getting quotes on Uniswap V3.
 *
 * @export
 * @interface IV3QuoteProvider
 */
export interface IV3QuoteProvider {
  /**
   * For every route, gets an exactIn quotes on V3 for every amount provided.
   *
   * @param amountIns The amounts to get quotes for.
   * @param routes The routes to get quotes for.
   * @param [providerConfig] The provider config.
   * @returns For each route returns a V3RouteWithQuotes object that contains all the quotes.
   * @returns The blockNumber used when generating the quotes.
   */
  getQuotesManyExactIn(
    amountIns: CurrencyAmount[],
    routes: V3Route[],
    providerConfig?: ProviderConfig
  ): Promise<{ routesWithQuotes: V3RouteWithQuotes[]; blockNumber: BigNumber }>;

  /**
   * For every route, gets ane exactOut quote on V3 for every amount provided.
   *
   * @param amountOuts The amounts to get quotes for.
   * @param routes The routes to get quotes for.
   * @param [providerConfig] The provider config.
   * @returns For each route returns a V3RouteWithQuotes object that contains all the quotes.
   * @returns The blockNumber used when generating the quotes.
   */
  getQuotesManyExactOut(
    amountOuts: CurrencyAmount[],
    routes: V3Route[],
    providerConfig?: ProviderConfig
  ): Promise<{ routesWithQuotes: V3RouteWithQuotes[]; blockNumber: BigNumber }>;
}

/**
 * The parameters for the multicalls we make.
 *
 * It is important to ensure that (gasLimitPerCall * multicallChunk) < providers gas limit per call.
 *
 * V3 quotes can consume a lot of gas (if the swap is so large that it swaps through a large
 * number of ticks), so there is a risk of exceeded gas limits in these multicalls.
 */
export type BatchParams = {
  /**
   * The number of quotes to fetch in each multicall.
   */
  multicallChunk: number;
  /**
   * The maximum call to consume for each quote in the multicall.
   */
  gasLimitPerCall: number;
  /**
   * The minimum success rate for all quotes across all multicalls.
   * If we set our gasLimitPerCall too low it could result in a large number of
   * quotes failing due to out of gas. This parameters will fail the overall request
   * in this case.
   */
  quoteMinSuccessRate: number;
};

export type SuccessRateFailureOverrides = {
  multicallChunk: number;
  gasLimitOverride: number;
};

/**
 * Computes quotes for V3. For V3, quotes are computed on-chain using
 * the 'QuoterV2' smart contract. This is because computing quotes off-chain would
 * require fetching all the tick data for each pool, which is a lot of data.
 *
 * To minimize the number of requests for quotes we use a Multicall contract. Generally
 * the number of quotes to fetch exceeds the maximum we can fit in a single multicall
 * while staying under gas limits, so we also batch these quotes across multiple multicalls.
 *
 * The biggest challenge with the quote provider is dealing with various gas limits.
 * Each provider sets a limit on the amount of gas a call can consume (on Infura this
 * is approximately 10x the block max size), so we must ensure each multicall does not
 * exceed this limit. Additionally, each quote on V3 can consume a large number of gas if
 * the pool lacks liquidity and the swap would cause all the ticks to be traversed.
 *
 * To ensure we don't exceed the node's call limit, we limit the gas used by each quote to
 * a specific value, and we limit the number of quotes in each multicall request. Users of this
 * class should set BatchParams such that multicallChunk * gasLimitPerCall is less than their node
 * providers total gas limit per call.
 *
 * @export
 * @class V3QuoteProvider
 */
export class V3QuoteProvider implements IV3QuoteProvider {
  protected quoterAddress: string;
  /**
   * Creates an instance of V3QuoteProvider.
   *
   * @param chainId The chain to get quotes for.
   * @param provider The web 3 provider.
   * @param multicall2Provider The multicall provider to use to get the quotes on-chain.
   * Only supports the Uniswap Multicall contract as it needs the gas limitting functionality.
   * @param retryOptions The retry options for each call to the multicall.
   * @param batchParams The parameters for each batched call to the multicall.
   * @param successRateFailureOverrides The parameters for retries when we fail to get quotes.
   * @param [rollback=false] If true, if we fail to get quotes due to block header
   *  errors (meaning the specified block wasn't found by the provider) we rollback the block number.
   * @param [quoterAddressOverride] Overrides the address of the quoter contract to use.
   */
  constructor(
    protected chainId: ChainId,
    protected provider: providers.BaseProvider,
    // Only supports Uniswap Multicall as it needs the gas limitting functionality.
    protected multicall2Provider: UniswapMulticallProvider,
    protected retryOptions: QuoteRetryOptions = {
      retries: 2,
      minTimeout: 25,
      maxTimeout: 250,
    },
    protected batchParams: BatchParams = {
      multicallChunk: 150,
      gasLimitPerCall: 1_000_000,
      quoteMinSuccessRate: 0.2,
    },
    protected successRateFailureOverrides: SuccessRateFailureOverrides = {
      gasLimitOverride: 1_300_000,
      multicallChunk: 110,
    },
    protected rollback: boolean = false,
    protected quoterAddressOverride?: string
  ) {
    const quoterAddress = quoterAddressOverride
      ? quoterAddressOverride
      : chainToQuoterAddress[this.chainId];

    if (!quoterAddress) {
      throw new Error(
        `No address for Uniswap QuoterV2 Contract on chain id: ${chainId}`
      );
    }

    this.quoterAddress = quoterAddress;
  }

  public async getQuotesManyExactIn(
    amountIns: CurrencyAmount[],
    routes: V3Route[],
    providerConfig?: ProviderConfig
  ): Promise<{
    routesWithQuotes: V3RouteWithQuotes[];
    blockNumber: BigNumber;
  }> {
    return this.getQuotesManyData(
      amountIns,
      routes,
      'quoteExactInput',
      providerConfig
    );
  }

  public async getQuotesManyExactOut(
    amountOuts: CurrencyAmount[],
    routes: V3Route[],
    providerConfig?: ProviderConfig
  ): Promise<{
    routesWithQuotes: V3RouteWithQuotes[];
    blockNumber: BigNumber;
  }> {
    return this.getQuotesManyData(
      amountOuts,
      routes,
      'quoteExactOutput',
      providerConfig
    );
  }

  private async getQuotesManyData(
    amounts: CurrencyAmount[],
    routes: V3Route[],
    functionName: 'quoteExactInput' | 'quoteExactOutput',
    _providerConfig?: ProviderConfig
  ): Promise<{
    routesWithQuotes: V3RouteWithQuotes[];
    blockNumber: BigNumber;
  }> {
    let multicallChunk = this.batchParams.multicallChunk;
    let gasLimitOverride = this.batchParams.gasLimitPerCall;

    const providerConfig: ProviderConfig = {
      ..._providerConfig,
      blockNumber:
        _providerConfig?.blockNumber ?? (await this.provider.getBlockNumber()),
    };

    const inputs: [string, string][] = _(routes)
      .flatMap((route) => {
        const encodedRoute = encodeRouteToPath(
          route,
          functionName == 'quoteExactOutput' // For exactOut must be true to ensure the routes are reversed.
        );
        const routeInputs: [string, string][] = amounts.map((amount) => [
          encodedRoute,
          `0x${amount.quotient.toString(16)}`,
        ]);
        return routeInputs;
      })
      .value();

    const normalizedChunk = Math.ceil(
      inputs.length / Math.ceil(inputs.length / multicallChunk)
    );

    const inputsChunked = _.chunk(inputs, normalizedChunk);
    let quoteStates: QuoteBatchState[] = _.map(inputsChunked, (inputChunk) => {
      return {
        status: 'pending',
        inputs: inputChunk,
      };
    });

    log.info(
      `About to get ${
        inputs.length
      } quotes in chunks of ${normalizedChunk} [${_.map(
        inputsChunked,
        (i) => i.length
      ).join(',')}] ${
        gasLimitOverride
          ? `with a gas limit override of ${gasLimitOverride}`
          : ''
      } and block number: ${await providerConfig.blockNumber}.`
    );

    let haveRetriedForSuccessRate = false;
    let haveRetriedForBlockHeader = false;
    let blockHeaderRetryAttemptNumber: number | undefined;
    let blockHeaderRolledBack = false;
    let haveRetriedForBlockConflictError = false;
    let haveRetriedForOutOfGas = false;
    let haveRetriedForTimeout = false;
    let haveRetriedForUnknownReason = false;
    let finalAttemptNumber = 1;
    let expectedCallsMade = quoteStates.length;
    let totalCallsMade = 0;

    const {
      results: quoteResults,
      blockNumber,
      approxGasUsedPerSuccessCall,
    } = await retry(
      async (_bail, attemptNumber) => {
        finalAttemptNumber = attemptNumber;

        const [success, failed, pending] = this.partitionQuotes(quoteStates);

        log.info(
          `Starting attempt: ${attemptNumber}.
          Currently ${success.length} success, ${failed.length} failed, ${
            pending.length
          } pending.
          Gas limit override: ${gasLimitOverride} Block number override: ${await providerConfig.blockNumber}.`
        );

        quoteStates = await Promise.all(
          _.map(
            quoteStates,
            async (quoteState: QuoteBatchState, idx: number) => {
              if (quoteState.status == 'success') {
                return quoteState;
              }

              // QuoteChunk is pending or failed, so we try again
              const { inputs } = quoteState;

              try {
                totalCallsMade = totalCallsMade + 1;

                const results =
                  await this.multicall2Provider.callSameFunctionOnContractWithMultipleParams<
                    [string, string],
                    [BigNumber, BigNumber[], number[], BigNumber] // amountIn/amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList, gasEstimate
                  >({
                    address: this.quoterAddress,
                    contractInterface: IQuoterV2__factory.createInterface(),
                    functionName,
                    functionParams: inputs,
                    providerConfig,
                    additionalConfig: {
                      gasLimitPerCallOverride: gasLimitOverride,
                    },
                  });

                const successRateError = this.validateSuccessRate(
                  results.results,
                  haveRetriedForSuccessRate
                );

                if (successRateError) {
                  return {
                    status: 'failed',
                    inputs,
                    reason: successRateError,
                    results,
                  } as QuoteBatchFailed;
                }

                return {
                  status: 'success',
                  inputs,
                  results,
                } as QuoteBatchSuccess;
              } catch (err: any) {
                // Error from providers have huge messages that include all the calldata and fill the logs.
                // Catch them and rethrow with shorter message.
                if (err.message.includes('header not found')) {
                  return {
                    status: 'failed',
                    inputs,
                    reason: new ProviderBlockHeaderError(
                      err.message.slice(0, 500)
                    ),
                  } as QuoteBatchFailed;
                }

                if (err.message.includes('timeout')) {
                  return {
                    status: 'failed',
                    inputs,
                    reason: new ProviderTimeoutError(
                      `Req ${idx}/${quoteStates.length}. Request had ${
                        inputs.length
                      } inputs. ${err.message.slice(0, 500)}`
                    ),
                  } as QuoteBatchFailed;
                }

                if (err.message.includes('out of gas')) {
                  return {
                    status: 'failed',
                    inputs,
                    reason: new ProviderGasError(err.message.slice(0, 500)),
                  } as QuoteBatchFailed;
                }

                return {
                  status: 'failed',
                  inputs,
                  reason: new Error(
                    `Unknown error from provider: ${err.message.slice(0, 500)}`
                  ),
                } as QuoteBatchFailed;
              }
            }
          )
        );

        const [successfulQuoteStates, failedQuoteStates, pendingQuoteStates] =
          this.partitionQuotes(quoteStates);

        if (pendingQuoteStates.length > 0) {
          throw new Error('Pending quote after waiting for all promises.');
        }

        let retryAll = false;

        const blockNumberError = this.validateBlockNumbers(
          successfulQuoteStates,
          inputsChunked.length,
          gasLimitOverride
        );

        // If there is a block number conflict we retry all the quotes.
        if (blockNumberError) {
          retryAll = true;
        }

        const reasonForFailureStr = _.map(
          failedQuoteStates,
          (failedQuoteState) => failedQuoteState.reason.name
        ).join(', ');

        if (failedQuoteStates.length > 0) {
          log.info(
            `On attempt ${attemptNumber}: ${failedQuoteStates.length}/${quoteStates.length} quotes failed. Reasons: ${reasonForFailureStr}`
          );

          for (const failedQuoteState of failedQuoteStates) {
            const { reason: error } = failedQuoteState;

            log.info(
              { error },
              `[QuoteFetchError] Attempt ${attemptNumber}. ${error.message}`
            );

            if (error instanceof BlockConflictError) {
              if (!haveRetriedForBlockConflictError) {
                metric.putMetric(
                  'QuoteBlockConflictErrorRetry',
                  1,
                  MetricLoggerUnit.Count
                );
                haveRetriedForBlockConflictError = true;
              }

              retryAll = true;
            } else if (error instanceof ProviderBlockHeaderError) {
              if (!haveRetriedForBlockHeader) {
                metric.putMetric(
                  'QuoteBlockHeaderNotFoundRetry',
                  1,
                  MetricLoggerUnit.Count
                );
                haveRetriedForBlockHeader = true;
              }

              if (
                blockHeaderRetryAttemptNumber &&
                blockHeaderRetryAttemptNumber < attemptNumber &&
                !blockHeaderRolledBack &&
                this.rollback
              ) {
                log.info(
                  `Attempt ${attemptNumber}. Another block header error. Rolling back block number for next retry`
                );
                providerConfig.blockNumber = providerConfig.blockNumber
                  ? (await providerConfig.blockNumber) - 1
                  : (await this.provider.getBlockNumber()) - 1;

                retryAll = true;
                blockHeaderRolledBack = true;
              }

              blockHeaderRetryAttemptNumber = attemptNumber;
            } else if (error instanceof ProviderTimeoutError) {
              if (!haveRetriedForTimeout) {
                metric.putMetric(
                  'QuoteTimeoutRetry',
                  1,
                  MetricLoggerUnit.Count
                );
                haveRetriedForTimeout = true;
              }
            } else if (error instanceof ProviderGasError) {
              if (!haveRetriedForOutOfGas) {
                metric.putMetric(
                  'QuoteOutOfGasExceptionRetry',
                  1,
                  MetricLoggerUnit.Count
                );
                haveRetriedForOutOfGas = true;
              }
              gasLimitOverride = 1_000_000;
              multicallChunk = 140;
            } else if (error instanceof SuccessRateError) {
              if (!haveRetriedForSuccessRate) {
                metric.putMetric(
                  'QuoteSuccessRateRetry',
                  1,
                  MetricLoggerUnit.Count
                );
                haveRetriedForSuccessRate = true;

                // Low success rate can indicate too little gas given to each call.
                gasLimitOverride =
                  this.successRateFailureOverrides.gasLimitOverride;
                multicallChunk =
                  this.successRateFailureOverrides.multicallChunk;
                retryAll = true;
              }
            } else {
              if (!haveRetriedForUnknownReason) {
                metric.putMetric(
                  'QuoteUnknownReasonRetry',
                  1,
                  MetricLoggerUnit.Count
                );
                haveRetriedForUnknownReason = true;
              }
            }
          }
        }

        if (retryAll) {
          log.info(
            `Attempt ${attemptNumber}. Resetting all requests to pending for next attempt.`
          );

          const normalizedChunk = Math.ceil(
            inputs.length / Math.ceil(inputs.length / multicallChunk)
          );

          const inputsChunked = _.chunk(inputs, normalizedChunk);
          quoteStates = _.map(inputsChunked, (inputChunk) => {
            return {
              status: 'pending',
              inputs: inputChunk,
            };
          });
        }

        if (failedQuoteStates.length > 0) {
          throw new Error(
            `Failed to get ${failedQuoteStates.length} quotes. Reasons: ${reasonForFailureStr}`
          );
        }

        const callResults = _.map(
          successfulQuoteStates,
          (quoteState) => quoteState.results
        );

        return {
          results: _.flatMap(callResults, (result) => result.results),
          blockNumber: BigNumber.from(callResults[0]!.blockNumber),
          approxGasUsedPerSuccessCall: stats.percentile(
            _.map(callResults, (result) => result.approxGasUsedPerSuccessCall),
            100
          ),
        };
      },
      {
        ...this.retryOptions,
      }
    );

    const routesQuotes = this.processQuoteResults(
      quoteResults,
      routes,
      amounts
    );

    metric.putMetric(
      'QuoteApproxGasUsedPerSuccessfulCall',
      approxGasUsedPerSuccessCall,
      MetricLoggerUnit.Count
    );

    metric.putMetric(
      'QuoteNumRetryLoops',
      finalAttemptNumber - 1,
      MetricLoggerUnit.Count
    );

    metric.putMetric(
      'QuoteTotalCallsToProvider',
      totalCallsMade,
      MetricLoggerUnit.Count
    );

    metric.putMetric(
      'QuoteExpectedCallsToProvider',
      expectedCallsMade,
      MetricLoggerUnit.Count
    );

    metric.putMetric(
      'QuoteNumRetriedCalls',
      totalCallsMade - expectedCallsMade,
      MetricLoggerUnit.Count
    );

    const [successfulQuotes, failedQuotes] = _(routesQuotes)
      .flatMap((routeWithQuotes: V3RouteWithQuotes) => routeWithQuotes[1])
      .partition((quote) => quote.quote != null)
      .value();

    log.info(
      `Got ${successfulQuotes.length} successful quotes, ${
        failedQuotes.length
      } failed quotes. Took ${
        finalAttemptNumber - 1
      } attempt loops. Total calls made to provider: ${totalCallsMade}. Have retried for timeout: ${haveRetriedForTimeout}`
    );

    return { routesWithQuotes: routesQuotes, blockNumber };
  }

  private partitionQuotes(
    quoteStates: QuoteBatchState[]
  ): [QuoteBatchSuccess[], QuoteBatchFailed[], QuoteBatchPending[]] {
    const successfulQuoteStates: QuoteBatchSuccess[] = _.filter<
      QuoteBatchState,
      QuoteBatchSuccess
    >(
      quoteStates,
      (quoteState): quoteState is QuoteBatchSuccess =>
        quoteState.status == 'success'
    );

    const failedQuoteStates: QuoteBatchFailed[] = _.filter<
      QuoteBatchState,
      QuoteBatchFailed
    >(
      quoteStates,
      (quoteState): quoteState is QuoteBatchFailed =>
        quoteState.status == 'failed'
    );

    const pendingQuoteStates: QuoteBatchPending[] = _.filter<
      QuoteBatchState,
      QuoteBatchPending
    >(
      quoteStates,
      (quoteState): quoteState is QuoteBatchPending =>
        quoteState.status == 'pending'
    );

    return [successfulQuoteStates, failedQuoteStates, pendingQuoteStates];
  }

  private processQuoteResults(
    quoteResults: Result<[BigNumber, BigNumber[], number[], BigNumber]>[],
    routes: V3Route[],
    amounts: CurrencyAmount[]
  ): V3RouteWithQuotes[] {
    const routesQuotes: V3RouteWithQuotes[] = [];

    const quotesResultsByRoute = _.chunk(quoteResults, amounts.length);

    const debugFailedQuotes: {
      amount: string;
      percent: number;
      route: string;
    }[] = [];

    for (let i = 0; i < quotesResultsByRoute.length; i++) {
      const route = routes[i]!;
      const quoteResults = quotesResultsByRoute[i]!;
      const quotes: V3AmountQuote[] = _.map(
        quoteResults,
        (
          quoteResult: Result<[BigNumber, BigNumber[], number[], BigNumber]>,
          index: number
        ) => {
          const amount = amounts[index]!;
          if (!quoteResult.success) {
            const percent = (100 / amounts.length) * (index + 1);

            const amountStr = amount.toFixed(2);
            const routeStr = routeToString(route);
            debugFailedQuotes.push({
              route: routeStr,
              percent,
              amount: amountStr,
            });

            return {
              amount,
              quote: null,
              sqrtPriceX96AfterList: null,
              gasEstimate: null,
              initializedTicksCrossedList: null,
            };
          }

          return {
            amount,
            quote: quoteResult.result[0],
            sqrtPriceX96AfterList: quoteResult.result[1],
            initializedTicksCrossedList: quoteResult.result[2],
            gasEstimate: quoteResult.result[3],
          };
        }
      );

      routesQuotes.push([route, quotes]);
    }

    // For routes and amounts that we failed to get a quote for, group them by route
    // and batch them together before logging to minimize number of logs.
    const debugChunk = 80;
    _.forEach(_.chunk(debugFailedQuotes, debugChunk), (quotes, idx) => {
      const failedQuotesByRoute = _.groupBy(quotes, (q) => q.route);
      const failedFlat = _.mapValues(failedQuotesByRoute, (f) =>
        _(f)
          .map((f) => `${f.percent}%[${f.amount}]`)
          .join(',')
      );

      log.info(
        {
          failedQuotes: _.map(
            failedFlat,
            (amounts, routeStr) => `${routeStr} : ${amounts}`
          ),
        },
        `Failed quotes for routes Part ${idx}/${Math.ceil(
          debugFailedQuotes.length / debugChunk
        )}`
      );
    });

    return routesQuotes;
  }

  private validateBlockNumbers(
    successfulQuoteStates: QuoteBatchSuccess[],
    totalCalls: number,
    gasLimitOverride?: number
  ): BlockConflictError | null {
    if (successfulQuoteStates.length <= 1) {
      return null;
    }

    const results = _.map(
      successfulQuoteStates,
      (quoteState) => quoteState.results
    );

    const blockNumbers = _.map(results, (result) => result.blockNumber);

    const uniqBlocks = _(blockNumbers)
      .map((blockNumber) => blockNumber.toNumber())
      .uniq()
      .value();

    if (uniqBlocks.length == 1) {
      return null;
    }

    /* if (
      uniqBlocks.length == 2 &&
      Math.abs(uniqBlocks[0]! - uniqBlocks[1]!) <= 1
    ) {
      return null;
    } */

    return new BlockConflictError(
      `Quotes returned from different blocks. ${uniqBlocks}. ${totalCalls} calls were made with gas limit ${gasLimitOverride}`
    );
  }

  protected validateSuccessRate(
    allResults: Result<[BigNumber, BigNumber[], number[], BigNumber]>[],
    haveRetriedForSuccessRate: boolean
  ): void | SuccessRateError {
    const numResults = allResults.length;
    const numSuccessResults = allResults.filter(
      (result) => result.success
    ).length;

    const successRate = (1.0 * numSuccessResults) / numResults;

    const { quoteMinSuccessRate } = this.batchParams;
    if (successRate < quoteMinSuccessRate) {
      if (haveRetriedForSuccessRate) {
        log.info(
          `Quote success rate still below threshold despite retry. Continuing. ${quoteMinSuccessRate}: ${successRate}`
        );
        return;
      }

      return new SuccessRateError(
        `Quote success rate below threshold of ${quoteMinSuccessRate}: ${successRate}`
      );
    }
  }
}
