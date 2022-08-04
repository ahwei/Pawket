import 'dotenv/config'
import { disassemble } from "clvm_tools/clvm_tools/binutils";
import { SExp, Tuple, to_sexp_f, sexp_from_stream, Stream, Bytes } from "clvm";
import { uncurry } from "clvm_tools/clvm_tools/curry";
import { modshexdict, modspuz } from "./mods";
import { getCoinName0x } from './coinUtility';
import { prefix0x, unprefix0x } from './condition';
import { sha256tree } from 'clvm_tools';
import puzzle from '../crypto/puzzle';

export interface SimplePuzzle {
  mod: string,
  args: (CannotUncurryArgument | SimplePuzzle)[],
}

export interface CannotUncurryArgument {
  raw: string,
}

export interface CannotParsePuzzle {
  raw: string,
}

export interface CoinInfo {
  parent: string;
  puzzle: string;
  parsed_puzzle: SimplePuzzle | CannotParsePuzzle;
  amount: string;
  solution: string;
  coin_name: string;
  mods: string;
  key_param?: string;
}

export async function simplifyPuzzle(origin: SExp, puz_hex: string | undefined = undefined): Promise<SimplePuzzle | CannotParsePuzzle> {
  try {
    if (!puz_hex) puz_hex = origin.as_bin().hex();
    puz_hex = unprefix0x(puz_hex);
    const puremodname = modshexdict[puz_hex];
    if (puremodname) return { mod: puremodname, args: [] };

    const [mod, args] = uncurry(origin) as Tuple<SExp, SExp>;
    const argarr: SExp[] = !args ? [] : Array.from(args.as_iter());
    const simpargs = (await Promise.all(argarr.map(_ => simplifyPuzzle(_))))
      .map((_: (SimplePuzzle | CannotParsePuzzle)) => "raw" in _ ? { raw: _.raw } : _);
    const mod_hex: string = mod.as_bin().hex();
    const modname = modshexdict[mod_hex];
    if (!modname) return { raw: prefix0x(puz_hex) };

    return { mod: modname, args: simpargs };
  } catch (err) {
    return { raw: puz_hex ? prefix0x(puz_hex) : "" };
  }
}

export async function parseCoin(all: SExp): Promise<CoinInfo> {
  const parent = disassemble(all.first());
  let next = all.rest();
  const puz = next.first();
  const puz_hex = prefix0x(puz.as_bin().hex());
  const decPuzzle = await simplifyPuzzle(puz, puz_hex);
  next = next.rest();
  const amount = next.first().as_bigint();
  next = next.rest();
  const solution = prefix0x(next.first().as_bin().hex());

  const puzzle_hash = sha256tree(puz).hex();
  const coin_name = getCoinName0x({ parent_coin_info: parent, puzzle_hash, amount });
  const mods = getModsPath(decPuzzle);
  const key_param = getKeyParam(decPuzzle)

  return { parent, puzzle: puz_hex, parsed_puzzle: decPuzzle, amount: amount.toString(), solution, coin_name, mods, key_param };
}

export async function parseBlock(generator_hex: string, ref_hex_list: string[] | undefined): Promise<string> {
  const getArgs = function (ref_list: string[]): SExp {
    return SExp.to([sexpAssemble(generator_hex), [ref_list.map(_ => Bytes.from(unprefix0x(_), "hex"))]]);
  };

  const bg = ref_hex_list?.length ?? 0 > 0
    ? await puzzle.calcPuzzleResult(await modspuz("generator"), getArgs(ref_hex_list ?? []).as_bin().hex(), "--hex", "--dump")
    : await puzzle.calcPuzzleResult(generator_hex, "ff8080", "--hex", "--dump"); // ff8080 == "(())"

  return bg;
}

function getModsPath(parsed_puzzle: SimplePuzzle | CannotParsePuzzle): string {
  if ("raw" in parsed_puzzle) return "";
  return `${parsed_puzzle.mod}(${parsed_puzzle.args.map(_ => getModsPath(_)).filter(_ => _).join(",")})`;
}

function getKeyParam(parsed_puzzle: SimplePuzzle | CannotParsePuzzle): string | undefined {
  if ("raw" in parsed_puzzle) return undefined;
  if (parsed_puzzle.mod == "cat_v1" || parsed_puzzle.mod == "cat_v2") {
    const tail = parsed_puzzle.args[1];
    if ("raw" in tail) return tail.raw;
  }

  if (parsed_puzzle.mod == "singleton_top_layer_v1_1") {
    const inner_puzzle = parsed_puzzle.args[1];
    if ("raw" in inner_puzzle) return undefined;
    if (inner_puzzle.mod == "nft_state_layer") {
      const nft_inner_puzzle = inner_puzzle.args[3];
      if ("raw" in nft_inner_puzzle) return undefined;
      if (nft_inner_puzzle.mod == "nft_ownership_layer") {
        const nft_transfer_puzzle = nft_inner_puzzle.args[2];
        if ("raw" in nft_transfer_puzzle) return undefined;
        if (nft_transfer_puzzle.mod == "nft_ownership_transfer_program_one_way_claim_with_royalties") {
          const royaltyAddress = nft_transfer_puzzle.args[1];
          if ("raw" in royaltyAddress) return royaltyAddress.raw;
        }
      }
    }
    else if (inner_puzzle.mod == "did_innerpuz") {
      const recovery = inner_puzzle.args[1];
      if ("raw" in recovery) return recovery.raw;
    }
  }

  return undefined;
}

export const sexpAssemble = function (hexString: string): SExp {
  const bts = Bytes.from(hexString, "hex")
  const input_sexp = sexp_from_stream(new Stream(bts as Bytes), to_sexp_f);
  return input_sexp;
};