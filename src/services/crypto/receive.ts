import { CoinRecord, GetRecordsResponse } from "@/models/wallet";
import store from "@/store";
import puzzle, { PuzzleAddress } from "./puzzle";
import { PuzzleDetail } from "./puzzle";
import utility from "./utility";
import { AccountTokenAddress, AccountTokens, CustomCat } from "@/store/modules/account";
import { rpcUrl, xchSymbol } from "@/store/modules/network";
import { prefix0x, unprefix0x } from "../coin/condition";
import debug from "../api/debug";
import { internalUncurry } from "../offer/summary";
import { modsdict } from "../coin/mods";
import { assemble } from 'clvm_tools/clvm_tools/binutils';
import { Bytes } from "clvm";

export interface TokenPuzzleDetail {
  symbol: string;
  puzzles: PuzzleDetail[];
}

export interface TokenPuzzleAddress {
  symbol: string;
  puzzles: PuzzleAddress[];
}

export interface NftDetail {
  metadata: {
    uri: string;
    hash: string;
  }
  hintPuzzle: string;
  realPuzzle: string;
}

class Receive {
  async getAssetsRequestDetail(sk_hex: string, maxId: number, customCats: CustomCat[]): Promise<TokenPuzzleDetail[]> {

    const privkey = utility.fromHexString(sk_hex);
    const xchToken = { symbol: xchSymbol(), puzzles: await puzzle.getPuzzleDetails(privkey, 0, maxId) };
    const tokens: TokenPuzzleDetail[] = [xchToken];
    const standardAssets = Object.values(store.state.account.tokenInfo)
      .filter(_ => _.id)
      .map(_ => ({ symbol: _.symbol, id: _.id ?? "" }));
    const accountAssets = (customCats ?? []).map(_ => ({ symbol: _.name, id: _.id }));
    const assets = standardAssets.concat(accountAssets);

    for (let i = 0; i < assets.length; i++) {
      const assetId = assets[i].id;
      const ps = await puzzle.getCatPuzzleDetails(privkey, assetId, 0, maxId);
      tokens.push(Object.assign({}, assets[i], { puzzles: ps }));
    }

    return tokens;
  }

  async getCoinRecords(tokens: TokenPuzzleAddress[], includeSpentCoins: boolean, hint = false): Promise<GetRecordsResponse> {
    const hashes = tokens.reduce((acc, token) => acc.concat(token.puzzles.map(_ => _.hash)), ([] as string[]));

    const resp = await fetch(rpcUrl() + "Wallet/records", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        puzzleHashes: hashes,
        includeSpentCoins,
        hint,
      }),
    });
    const json = (await resp.json()) as GetRecordsResponse;
    return json;
  }

  getAssetsDict(requests: TokenPuzzleAddress[]): { [key: string]: string } {
    const dictAssets: { [key: string]: string } = {};
    for (let i = 0; i < requests.length; i++) {
      const t = requests[i];
      for (let j = 0; j < t.puzzles.length; j++) {
        const p = t.puzzles[j];
        dictAssets[p.hash] = t.symbol
      }
    }
    return dictAssets;
  }

  async getActivities(tokens: TokenPuzzleAddress[], includeSpentCoins: boolean): Promise<CoinRecord[]> {
    const records = (await this.getCoinRecords(tokens, includeSpentCoins));
    const activities = this.convertActivities(tokens, records);
    return activities;
  }

  convertActivities(tokens: TokenPuzzleAddress[], records: GetRecordsResponse): CoinRecord[] {
    const dictAssets = this.getAssetsDict(tokens);

    const activities = records.coins.reduce(
      (acc, puzzle) => acc.concat(puzzle.records
        .reduce<CoinRecord[]>((recacc, rec) => recacc.concat(rec), [])
        .map(rec => Object.assign({}, rec, { symbol: dictAssets[puzzle.puzzleHash] }))),
      ([] as CoinRecord[]))
      .sort((a, b) => b.timestamp - a.timestamp);
    return activities;
  }

  getTokenBalance(tokens: TokenPuzzleAddress[], records: GetRecordsResponse): AccountTokens {
    const dictAssets = this.getAssetsDict(tokens);

    const tokenBalances: AccountTokens = {};

    for (let i = 0; i < tokens.length; i++) {
      const symbol = tokens[i].symbol;
      tokenBalances[symbol] = {
        amount: records.coins.filter(_ => dictAssets[_.puzzleHash] == symbol).reduce((pv, cur) => pv + BigInt(cur.balance), 0n),
        addresses: tokens[i].puzzles
          .map<AccountTokenAddress>(_ => ({
            address: _.address,
            coins: (records.coins.find(c => prefix0x(_.hash) == c.puzzleHash) || { records: [] }).records,
          })),
      };
    }

    return tokenBalances;
  }

  async getNfts(records: GetRecordsResponse): Promise<NftDetail[]> {
    const nftList: NftDetail[] = [];
    for (let i = 0; i < records.coins.length; i++) {
      const coinRecords = records.coins[i];

      for (let j = 0; j < coinRecords.records.length; j++) {
        const coinRecord = coinRecords.records[j];

        if (!coinRecord.coin?.parentCoinInfo) {
          console.warn("coin cannot record", coinRecord);
          continue;
        }

        const scoin = await debug.getCoinSolution(coinRecord.coin.parentCoinInfo);
        const puz = await puzzle.disassemblePuzzle(scoin.puzzle_reveal);
        const { module, args } = await internalUncurry(puz);

        if (modsdict[module] == "singleton_top_layer_v1_1" && args.length == 2) {
          const { module: smodule, args: sargs } = await internalUncurry(args[1]);
          if (modsdict[smodule] == "nft_state_layer" && sargs.length == 4) {
            const rawmeta = sargs[1];
            const metaprog = assemble(rawmeta);
            const metalist: string[][] = (metaprog.as_javascript() as Bytes[][])
              .map(_ => Array.from(_))
              .map(_ => _.map(it => it.hex()));
            const hex2asc = function (hex: string | undefined): string | undefined {
              if (!hex) return hex;
              return Buffer.from(hex, "hex").toString();
            }
            const uri = hex2asc(metalist.find(_ => _[0] == "75")?.[1]);// 75_hex = 117_dec for u
            const hash = metalist.find(_ => _[0] == "68")?.[1];// 68_hex = 104_dec for h
            if (!uri || !hash) continue;
            nftList.push({
              metadata: {
                uri,
                hash,
              },
              hintPuzzle: coinRecords.puzzleHash,
              realPuzzle: unprefix0x(coinRecord.coin.puzzleHash),
            })
          }
        }
      }
    }

    return nftList;
  }
}

export default new Receive();

