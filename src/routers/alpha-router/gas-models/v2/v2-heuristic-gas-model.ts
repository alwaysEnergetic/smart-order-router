import { BigNumber } from '@ethersproject/bignumber';
import { Token } from '@uniswap/sdk-core';
import { Pair } from '@uniswap/v2-sdk';
import _ from 'lodash';
import { V2PoolAccessor } from '../../../../providers/v2/pool-provider';
import { ChainId, log, WETH9 } from '../../../../util';
import { CurrencyAmount } from '../../../../util/amounts';
import { V2RouteWithValidQuote } from '../../entities/route-with-valid-quote';
import {
  IGasModel,
  IV2GasModelFactory,
  usdGasTokensByChain,
} from '../gas-model';

// Constant cost for doing any swap regardless of pools.
const BASE_SWAP_COST = BigNumber.from(100000);

// Constant per extra hop in the route.
const COST_PER_EXTRA_HOP = BigNumber.from(20000);

export class V2HeuristicGasModelFactory extends IV2GasModelFactory {
  constructor() {
    super();
  }

  public buildGasModel(
    chainId: ChainId,
    _gasPriceWei: BigNumber,
    _poolAccessor: V2PoolAccessor,
    token: Token
  ): IGasModel<V2RouteWithValidQuote> {
    if (token.equals(WETH9[chainId]!)) {
      const usdPool: Pair = this.getHighestLiquidityUSDPool(
        chainId,
        _poolAccessor
      );

      return {
        estimateGasCost: (routeWithValidQuote: V2RouteWithValidQuote) => {
          const { gasCostInEth, gasUse } = this.estimateGas(
            routeWithValidQuote,
            _gasPriceWei,
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
        },
      };
    }

    // If the quote token is not WETH, we convert the gas cost to be in terms of the quote token.
    // We do this by getting the highest liquidity <token>/ETH pool.
    const ethPool: Pair | null = this.getEthPool(chainId, token, _poolAccessor);

    const usdPool: Pair = this.getHighestLiquidityUSDPool(
      chainId,
      _poolAccessor
    );

    return {
      estimateGasCost: (routeWithValidQuote: V2RouteWithValidQuote) => {
        const usdToken =
          usdPool.token0.address == WETH9[chainId]!.address
            ? usdPool.token1
            : usdPool.token0;

        const { gasCostInEth, gasUse } = this.estimateGas(
          routeWithValidQuote,
          _gasPriceWei,
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
          log.error(
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
          log.error(
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
      },
    };
  }

  private estimateGas(
    routeWithValidQuote: V2RouteWithValidQuote,
    gasPriceWei: BigNumber,
    chainId: ChainId
  ) {
    const hops = routeWithValidQuote.route.pairs.length;
    const gasUse = BASE_SWAP_COST.add(COST_PER_EXTRA_HOP.mul(hops - 1));

    const totalGasCostWei = gasPriceWei.mul(gasUse);

    const weth = WETH9[chainId]!;

    const gasCostInEth = CurrencyAmount.fromRawAmount(
      weth,
      totalGasCostWei.toString()
    );

    return { gasCostInEth, gasUse };
  }

  private getEthPool(
    chainId: ChainId,
    token: Token,
    poolAccessor: V2PoolAccessor
  ): Pair | null {
    const weth = WETH9[chainId]!;

    const pool = poolAccessor.getPool(weth, token);

    if (!pool) {
      log.error(
        { weth, token },
        `Could not find a WETH pool with ${token.symbol} for computing gas costs.`
      );

      return null;
    }

    return pool;
  }

  private getHighestLiquidityUSDPool(
    chainId: ChainId,
    poolAccessor: V2PoolAccessor
  ): Pair {
    const usdTokens = usdGasTokensByChain[chainId];

    if (!usdTokens) {
      throw new Error(
        `Could not find a USD token for computing gas costs on ${chainId}`
      );
    }

    const pools = [];

    for (const usdToken of usdTokens) {
      const pool = poolAccessor.getPool(WETH9[chainId]!, usdToken);
      if (pool) {
        pools.push(pool);
      }
    }

    if (pools.length == 0) {
      log.error(
        { pools },
        `Could not find a USD/WETH pool for computing gas costs.`
      );
      throw new Error(`Can't find USD/WETH pool for computing gas costs.`);
    }

    const maxPool = _.maxBy(pools, (pool) => {
      if (pool.token0.equals(WETH9[chainId]!)) {
        return parseFloat(pool.reserve0.toSignificant(2));
      } else {
        return parseFloat(pool.reserve1.toSignificant(2));
      }
    }) as Pair;

    return maxPool;
  }
}
