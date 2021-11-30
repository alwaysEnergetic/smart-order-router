import { BigNumber } from '@ethersproject/bignumber';
import { Token } from '@uniswap/sdk-core';
import { FeeAmount, Pool } from '@uniswap/v3-sdk';
import _ from 'lodash';
import { IV3PoolProvider } from '../../../../providers/v3/pool-provider';
import { ChainId, WETH9 } from '../../../../util';
import { CurrencyAmount } from '../../../../util/amounts';
import { log } from '../../../../util/log';
import { V3RouteWithValidQuote } from '../../entities/route-with-valid-quote';
import {
  IGasModel,
  IV3GasModelFactory,
  usdGasTokensByChain,
} from '../gas-model';

// Constant cost for doing any swap regardless of pools.
const BASE_SWAP_COST = BigNumber.from(2000);

// Cost for crossing an initialized tick.
const COST_PER_INIT_TICK = BigNumber.from(31000);

// Cost for crossing an uninitialized tick.
const COST_PER_UNINIT_TICK = BigNumber.from(0);

// Constant per pool swap in the route.
const COST_PER_HOP = BigNumber.from(80000);

/**
 * Computes a gas estimate for a V3 swap using heuristics.
 * Considers number of hops in the route, number of ticks crossed
 * and the typical base cost for a swap.
 *
 * We get the number of ticks crossed in a swap from the QuoterV2
 * contract.
 *
 * We compute gas estimates off-chain because
 *  1/ Calling eth_estimateGas for a swaps requires the caller to have
 *     the full balance token being swapped, and approvals.
 *  2/ Tracking gas used using a wrapper contract is not accurate with Multicall
 *     due to EIP-2929. We would have to make a request for every swap we wanted to estimate.
 *  3/ For V2 we simulate all our swaps off-chain so have no way to track gas used.
 *
 * @export
 * @class V3HeuristicGasModelFactory
 */
export class V3HeuristicGasModelFactory extends IV3GasModelFactory {
  constructor() {
    super();
  }

  public async buildGasModel(
    chainId: ChainId,
    gasPriceWei: BigNumber,
    poolProvider: IV3PoolProvider,
    token: Token
  ): Promise<IGasModel<V3RouteWithValidQuote>> {
    // If our quote token is WETH, we don't need to convert our gas use to be in terms
    // of the quote token in order to produce a gas adjusted amount.
    // We do return a gas use in USD however, so we still convert to usd.
    if (token.equals(WETH9[chainId]!)) {
      const usdPool: Pool = await this.getHighestLiquidityUSDPool(
        chainId,
        poolProvider
      );

      const estimateGasCost = (
        routeWithValidQuote: V3RouteWithValidQuote
      ): {
        gasEstimate: BigNumber;
        gasCostInToken: CurrencyAmount;
        gasCostInUSD: CurrencyAmount;
      } => {
        const { gasCostInEth, gasUse } = this.estimateGas(
          routeWithValidQuote,
          gasPriceWei,
          chainId
        );

        const ethToken0 = usdPool.token0.address == WETH9[chainId]!.address;

        const ethTokenPrice = ethToken0
          ? usdPool.token0Price
          : usdPool.token1Price;

        const gasCostInTermsOfUSD: CurrencyAmount = ethTokenPrice.quote(
          gasCostInEth
        ) as CurrencyAmount;

        return {
          gasEstimate: gasUse,
          gasCostInToken: gasCostInEth,
          gasCostInUSD: gasCostInTermsOfUSD,
        };
      };

      return {
        estimateGasCost,
      };
    }

    // If the quote token is not WETH, we convert the gas cost to be in terms of the quote token.
    // We do this by getting the highest liquidity <token>/ETH pool.
    const ethPool: Pool | null = await this.getHighestLiquidityEthPool(
      chainId,
      token,
      poolProvider
    );

    const usdPool: Pool = await this.getHighestLiquidityUSDPool(
      chainId,
      poolProvider
    );

    const usdToken =
      usdPool.token0.address == WETH9[chainId]!.address
        ? usdPool.token1
        : usdPool.token0;

    const estimateGasCost = (
      routeWithValidQuote: V3RouteWithValidQuote
    ): {
      gasEstimate: BigNumber;
      gasCostInToken: CurrencyAmount;
      gasCostInUSD: CurrencyAmount;
    } => {
      const { gasCostInEth, gasUse } = this.estimateGas(
        routeWithValidQuote,
        gasPriceWei,
        chainId
      );

      if (!ethPool) {
        log.info(
          'Unable to find ETH pool with the quote token to produce gas adjusted costs. Route will not account for gas.'
        );
        return {
          gasEstimate: gasUse,
          gasCostInToken: CurrencyAmount.fromRawAmount(token, 0),
          gasCostInUSD: CurrencyAmount.fromRawAmount(usdToken, 0),
        };
      }

      const ethToken0 = ethPool.token0.address == WETH9[chainId]!.address;

      const ethTokenPrice = ethToken0
        ? ethPool.token0Price
        : ethPool.token1Price;

      let gasCostInTermsOfQuoteToken: CurrencyAmount;
      try {
        gasCostInTermsOfQuoteToken = ethTokenPrice.quote(
          gasCostInEth
        ) as CurrencyAmount;
      } catch (err) {
        log.info(
          {
            ethTokenPriceBase: ethTokenPrice.baseCurrency,
            ethTokenPriceQuote: ethTokenPrice.quoteCurrency,
            gasCostInEth: gasCostInEth.currency,
          },
          'Debug eth price token issue'
        );
        throw err;
      }

      const ethToken0USDPool =
        usdPool.token0.address == WETH9[chainId]!.address;

      const ethTokenPriceUSDPool = ethToken0USDPool
        ? usdPool.token0Price
        : usdPool.token1Price;

      let gasCostInTermsOfUSD: CurrencyAmount;
      try {
        gasCostInTermsOfUSD = ethTokenPriceUSDPool.quote(
          gasCostInEth
        ) as CurrencyAmount;
      } catch (err) {
        log.info(
          {
            usdT1: usdPool.token0.symbol,
            usdT2: usdPool.token1.symbol,
            gasCostInEthToken: gasCostInEth.currency.symbol,
          },
          'Failed to compute USD gas price'
        );
        throw err;
      }

      return {
        gasEstimate: gasUse,
        gasCostInToken: gasCostInTermsOfQuoteToken,
        gasCostInUSD: gasCostInTermsOfUSD!,
      };
    };

    return {
      estimateGasCost: estimateGasCost.bind(this),
    };
  }

  private estimateGas(
    routeWithValidQuote: V3RouteWithValidQuote,
    gasPriceWei: BigNumber,
    chainId: ChainId
  ) {
    const totalInitializedTicksCrossed = Math.max(
      1,
      _.sum(routeWithValidQuote.initializedTicksCrossedList)
    );
    const totalHops = BigNumber.from(routeWithValidQuote.route.pools.length);

    const hopsGasUse = COST_PER_HOP.mul(totalHops);
    const tickGasUse = COST_PER_INIT_TICK.mul(totalInitializedTicksCrossed);
    const uninitializedTickGasUse = COST_PER_UNINIT_TICK.mul(0);

    const gasUse = BASE_SWAP_COST.add(hopsGasUse)
      .add(tickGasUse)
      .add(uninitializedTickGasUse);

    const totalGasCostWei = gasPriceWei.mul(gasUse);

    const weth = WETH9[chainId]!;

    const gasCostInEth = CurrencyAmount.fromRawAmount(
      weth,
      totalGasCostWei.toString()
    );

    return { gasCostInEth, gasUse };
  }

  private async getHighestLiquidityEthPool(
    chainId: ChainId,
    token: Token,
    poolProvider: IV3PoolProvider
  ): Promise<Pool | null> {
    const weth = WETH9[chainId]!;

    const ethPools = _([FeeAmount.HIGH, FeeAmount.MEDIUM, FeeAmount.LOW])
      .map<[Token, Token, FeeAmount]>((feeAmount) => {
        return [weth, token, feeAmount];
      })
      .value();

    const poolAccessor = await poolProvider.getPools(ethPools);

    const pools = _([FeeAmount.HIGH, FeeAmount.MEDIUM, FeeAmount.LOW])
      .map((feeAmount) => {
        return poolAccessor.getPool(weth, token, feeAmount);
      })
      .compact()
      .value();

    if (pools.length == 0) {
      log.error(
        { pools },
        `Could not find a WETH pool with ${token.symbol} for computing gas costs.`
      );

      return null;
    }

    const maxPool = _.maxBy(pools, (pool) => pool.liquidity) as Pool;

    return maxPool;
  }

  private async getHighestLiquidityUSDPool(
    chainId: ChainId,
    poolProvider: IV3PoolProvider
  ): Promise<Pool> {
    const usdTokens = usdGasTokensByChain[chainId];

    if (!usdTokens) {
      throw new Error(
        `Could not find a USD token for computing gas costs on ${chainId}`
      );
    }

    const usdPools = _([
      FeeAmount.HIGH,
      FeeAmount.MEDIUM,
      FeeAmount.LOW,
      FeeAmount.LOWEST,
    ])
      .flatMap((feeAmount) => {
        return _.map<Token, [Token, Token, FeeAmount]>(
          usdTokens,
          (usdToken) => [WETH9[chainId]!, usdToken, feeAmount]
        );
      })
      .value();

    const poolAccessor = await poolProvider.getPools(usdPools);

    const pools = _([
      FeeAmount.HIGH,
      FeeAmount.MEDIUM,
      FeeAmount.LOW,
      FeeAmount.LOWEST,
    ])
      .flatMap((feeAmount) => {
        const pools = [];

        for (const usdToken of usdTokens) {
          const pool = poolAccessor.getPool(
            WETH9[chainId]!,
            usdToken,
            feeAmount
          );
          if (pool) {
            pools.push(pool);
          }
        }

        return pools;
      })
      .compact()
      .value();

    if (pools.length == 0) {
      log.error(
        { pools },
        `Could not find a USD/WETH pool for computing gas costs.`
      );
      throw new Error(`Can't find USD/WETH pool for computing gas costs.`);
    }

    const maxPool = _.maxBy(pools, (pool) => pool.liquidity) as Pool;

    return maxPool;
  }
}
