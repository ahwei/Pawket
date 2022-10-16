import { Bytes } from "clvm";
import { CoinSpend, OriginCoin, SpendBundle } from "@/models/wallet";
import { Hex0x, prefix0x, unprefix0x } from "../coin/condition";
import puzzle from "../crypto/puzzle";
import { TokenPuzzleDetail } from "../crypto/receive";
import transfer, { SymbolCoins, TransferTarget } from "../transfer/transfer";
import { curryMod } from "../offer/bundler";
import { modshash, modsprog } from "../coin/mods";
import { getCoinName0x, NetworkContextWithOptionalApi } from "../coin/coinUtility";
import { Instance } from "../util/instance";

export interface MintCatInfo {
  spendBundle: SpendBundle;
  assetId: string;
}

interface CatPuzzleResponse {
  innerPuzzle: PuzzleInfo;
  catPuzzle: PuzzleInfo;
  assetId: Hex0x;
  bootstrapCoin: Hex0x;
}

interface PuzzleInfo {
  plaintext: string;
  hash: Hex0x;
}

export async function generateMintCatBundle(
  targetAddress: string,
  changeAddress: string,
  amount: bigint,
  fee: bigint,
  memo: string,
  availcoins: SymbolCoins,
  sk_hex: string,
  requests: TokenPuzzleDetail[],
  net: NetworkContextWithOptionalApi,
  catModName: "cat_v1" | "cat_v2" = "cat_v2",
): Promise<MintCatInfo> {
  const tgt_hex = prefix0x(puzzle.getPuzzleHashFromAddress(targetAddress));
  const change_hex = prefix0x(puzzle.getPuzzleHashFromAddress(changeAddress));

  // there is error in checking this regular expression
  // eslint-disable-next-line no-useless-escape
  memo = memo.replace(/[&/\\#,+()$~%.'":*?<>{}\[\] ]/g, "_");

  const { innerPuzzle, catPuzzle, assetId, bootstrapCoin } = await constructCatPuzzle(tgt_hex, change_hex, amount, fee, memo, availcoins, net.symbol, catModName);
  const ibundle = await constructInternalBundle(catPuzzle.hash, change_hex, amount, fee, availcoins, requests, net);
  const ebundle = await constructExternalBundle(innerPuzzle, catPuzzle, bootstrapCoin, amount, sk_hex, net.chainId);
  const bundle = await combineSpendBundlePure(ibundle, ebundle);

  return {
    spendBundle: bundle,
    assetId,
  }
}

async function constructCatPuzzle(
  tgt_hex: Hex0x,
  change_hex: Hex0x,
  amount: bigint,
  fee: bigint,
  memo: string,
  availcoins: SymbolCoins,
  tokenSymbol: string,
  catModName: "cat_v1" | "cat_v2" = "cat_v2",
): Promise<CatPuzzleResponse> {
  const baseSymbol = Object.keys(availcoins)[0];
  const itgts: TransferTarget[] = [
    { address: "0x0000000000000000000000000000000000000000000000000000000000000000", amount, symbol: baseSymbol },
  ];

  const tempplan = transfer.generateSpendPlan(availcoins, itgts, change_hex, fee, tokenSymbol);
  const catmod = prefix0x(modshash[catModName]);
  const bootstrapCoin = getCoinName0x(tempplan[baseSymbol].coins[0]);
  const curried_tail = await curryMod(modsprog["genesis_by_coin_id"], bootstrapCoin);
  if (!curried_tail) throw new Error("failed to curry tail.");

  const tail_hash = prefix0x(await puzzle.getPuzzleHashFromPuzzle(curried_tail));
  const inner_puzzle = `(q (51 () -113 ${curried_tail} ()) (51 ${tgt_hex} ${amount} (${tgt_hex} ${memo})))`;
  const inner_puzzle_hash = prefix0x(await puzzle.getPuzzleHashFromPuzzle(inner_puzzle));

  const catPuzzle = await curryMod(modsprog[catModName], catmod, tail_hash, inner_puzzle);
  if (!catPuzzle) throw new Error("failed to curry cat.");
  const catPuzzleHash = prefix0x(await puzzle.getPuzzleHashFromPuzzle(catPuzzle));

  return {
    innerPuzzle: { plaintext: inner_puzzle, hash: inner_puzzle_hash },
    catPuzzle: { plaintext: catPuzzle, hash: catPuzzleHash },
    assetId: tail_hash,
    bootstrapCoin,
  }
}

async function constructInternalBundle(
  tgt_hex: Hex0x,
  change_hex: Hex0x,
  amount: bigint,
  fee: bigint,
  availcoins: SymbolCoins,
  requests: TokenPuzzleDetail[],
  net: NetworkContextWithOptionalApi,
): Promise<SpendBundle> {
  const baseSymbol = Object.keys(availcoins)[0];
  const tgts: TransferTarget[] = [{ address: tgt_hex, amount, symbol: baseSymbol },];
  tgts[0].address = tgt_hex;
  const plan = transfer.generateSpendPlan(availcoins, tgts, change_hex, fee, net.symbol);
  const bundle = await transfer.generateSpendBundleWithoutCat(plan, requests, [], net);
  return bundle;
}

async function constructExternalBundle(
  innerPuzzle: PuzzleInfo,
  catPuzzle: PuzzleInfo,
  bootstrapCoin: Hex0x,
  amount: bigint,
  sk_hex: string,
  chainId: string,
): Promise<SpendBundle> {
  const coin: OriginCoin = { parent_coin_info: bootstrapCoin, amount, puzzle_hash: catPuzzle.hash };
  const coin_name = getCoinName0x(coin);

  const catsln = `(() () ${coin_name} (${bootstrapCoin} ${catPuzzle.hash} ${amount}) (${bootstrapCoin} ${innerPuzzle.hash} ${amount}) () ())`;
  const puzzle_reveal = prefix0x(await puzzle.encodePuzzle(catPuzzle.plaintext));
  const solution = prefix0x(await puzzle.encodePuzzle(catsln));

  const cs: CoinSpend[] = [{ coin, puzzle_reveal, solution }];

  const tempSymbol = "TEMP_SYMBOL";
  const puzzles: TokenPuzzleDetail[] = [
    {
      symbol: tempSymbol,
      puzzles: [
        {
          privateKey: puzzle.getPrivateKeyFromHex(sk_hex),
          puzzle: catPuzzle.plaintext,
          hash: unprefix0x(catPuzzle.hash),
          address: "",
        },
      ],
    },
  ];
  const bundle = await transfer.getSpendBundle(cs, puzzles, chainId);
  return bundle;
}

export async function combineSpendBundlePure(
  ...spendbundles: (SpendBundle | undefined)[]
): Promise<SpendBundle> {
  const BLS = Instance.BLS;
  if (!BLS) throw new Error("BLS not initialized");

  const withsigs = spendbundles
    .filter(_ => _ && _.aggregated_signature) as SpendBundle[];
  const sigs = withsigs
    .map(_ => BLS.G2Element.from_bytes(Bytes.from(_.aggregated_signature, "hex").raw()));
  const agg_sig = BLS.AugSchemeMPL.aggregate(sigs);
  const sig = Bytes.from(agg_sig.serialize()).hex();

  const spends = withsigs.flatMap(_ => _.coin_spends);

  return {
    aggregated_signature: prefix0x(sig),
    coin_spends: spends,
  }
}